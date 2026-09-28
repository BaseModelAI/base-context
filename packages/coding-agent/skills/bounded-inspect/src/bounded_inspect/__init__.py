"""Bounded file evidence. Select lazily; emit one shared-budget JSON bundle."""

import argparse
import json
import os
import stat
import sys
from dataclasses import dataclass

__all__ = ["text", "json_fields", "emit"]


@dataclass(frozen=True)
class _Selection:
    kind: str
    path: str
    options: dict


def text(path, *, head_lines=None, tail_lines=None, start_line=None, end_line=None, cursor=None):
    """Select UTF-8 lines (1-based, inclusive), or resume a returned byte cursor."""
    modes = sum(value is not None for value in (head_lines, tail_lines, start_line, cursor))
    if modes > 1 or (end_line is not None and start_line is None):
        raise ValueError("choose head, tail, line range, or cursor")
    for value in (head_lines, tail_lines, start_line, end_line):
        if value is not None and (not isinstance(value, int) or value < 1):
            raise ValueError("line counts must be positive integers")
    if start_line is not None and end_line is not None and end_line < start_line:
        raise ValueError("end_line precedes start_line")
    if modes == 0:
        head_lines = 25
    return _Selection("text", os.fspath(path), dict(head=head_lines, tail=tail_lines,
                      start=start_line, end=end_line, cursor=dict(cursor) if cursor else cursor))


def json_fields(path, *, pointers, max_source_bytes=65536):
    """Select exact RFC 6901 pointers; missing is distinct from JSON null."""
    pointers = tuple(pointers)
    if any(not isinstance(p, str) or (p and not p.startswith("/")) for p in pointers):
        raise ValueError("pointers must be empty (root) or start with /")
    if max_source_bytes < 0:
        raise ValueError("max_source_bytes must be nonnegative")
    return _Selection("json", os.fspath(path), dict(pointers=pointers, cap=max_source_bytes))


def _version(info):
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]


class _JsonNumber(str):
    """A number token validated by json.loads, not converted through float/int."""


def _serialized(value):
    if isinstance(value, _JsonNumber):
        return str(value)
    if isinstance(value, dict):
        return "{" + ",".join(_serialized(key) + ":" + _serialized(item) for key, item in value.items()) + "}"
    if isinstance(value, list):
        return "[" + ",".join(_serialized(item) for item in value) + "]"
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":"))


def _encoded(bundle):
    # Count the complete wire envelope, including escaping and the final newline.
    while True:
        rendered = _serialized(bundle) + "\n"
        size = len(rendered.encode("utf-8"))
        if bundle["output_bytes"] == size:
            return rendered
        bundle["output_bytes"] = size


def _read(handle, count, bundle):
    data = handle.read(max(0, min(count, bundle["limits"]["source_bytes"] - bundle["source_bytes"])))
    bundle["source_bytes"] += len(data)
    return data


def _cursor(path, version, offset, line, start, end, warnings):
    return dict(path=path, version=version, offset=offset, line=line,
                start_line=start, end_line=end, warnings=warnings)


def _text(handle, selection, version, bundle):
    options = selection.options
    size = version[2]
    cap = bundle["limits"]["source_bytes"] - bundle["source_bytes"]
    cursor = options["cursor"]
    warnings = []
    offset, line = 0, 1
    start, end = options["start"] or 1, options["end"] or options["head"]
    if cursor is not None:
        if cursor.get("path") != selection.path or cursor.get("version") != version:
            return {"status": "changed_source", "next": None}, None
        try:
            offset, line = cursor["offset"], cursor["line"]
            start, end = cursor["start_line"], cursor["end_line"]
            warnings = cursor["warnings"]
            if not isinstance(offset, int) or not 0 <= offset <= size:
                raise ValueError()
        except (KeyError, TypeError, ValueError):
            return {"status": "invalid_cursor", "next": None}, None
    elif options["tail"] is not None:
        offset = max(0, size - cap)
        line = 1 if offset == 0 else None
        end = None
    handle.seek(offset)
    raw = _read(handle, size - offset, bundle)
    if options["tail"] is not None:
        # Work backwards only within the bounded suffix, never scan the prefix.
        boundaries = [i + 1 for i, value in enumerate(raw) if value == 10 and i + 1 < len(raw)]
        needed = options["tail"]
        cut = boundaries[-needed] if len(boundaries) >= needed else 0
        if offset and not cut:
            warnings.append("tail_prefix_unread; absolute_line_unavailable")
            while cut < len(raw) and raw[cut] & 0xC0 == 0x80:
                cut += 1
        if line is not None:
            line += raw[:cut].count(b"\n")
        offset += cut
        raw = raw[cut:]
    # Seek a requested line in bounded chunks. Cursors can advance without text.
    if line is not None:
        while line < start:
            newline = raw.find(b"\n")
            if newline < 0:
                offset += len(raw)
                raw = b""
                break
            offset += newline + 1
            raw = raw[newline + 1:]
            line += 1
        if end is not None:
            limit = end - line + 1
            if limit <= 0:
                raw = b""
            else:
                pos = 0
                for _ in range(limit):
                    newline = raw.find(b"\n", pos)
                    if newline < 0:
                        break
                    pos = newline + 1
                else:
                    raw = raw[:pos]
    try:
        decoded = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        if error.reason != "unexpected end of data" or offset + len(raw) == size:
            return {"status": "invalid_utf8", "byte": offset + error.start, "next": None}, None
        decoded = raw[:error.start].decode("utf-8")
    context = (selection.path, version, offset, line, start, end, warnings)
    if not decoded:
        seeking = line is not None and line < start and offset < size
        done = offset == size or (end is not None and line is not None and line > end)
        status = "complete" if done else "seeking" if seeking and raw == b"" and cap else "source_limit"
        next_cursor = _cursor(*context) if status == "seeking" else None
        return dict(status=status, text="", range={"bytes": [offset, offset], "line": line},
                    next=next_cursor, warnings=warnings), None
    return {}, (decoded, context)


def _text_prefix(decoded, context, length):
    path, version, offset, line, start, end, warnings = context
    value = decoded[:length]
    stop = offset + len(value.encode("utf-8"))
    next_line = None if line is None else line + value.count("\n")
    done = stop == version[2] or (end is not None and next_line is not None and next_line > end)
    status = ("tail_window_limit" if warnings else "complete") if done else "partial" if length else "output_limit"
    following = None if done or not length else _cursor(path, version, stop, next_line, start, end, warnings)
    return dict(status=status, text=value, range={"bytes": [offset, stop], "line": line},
                next=following, warnings=warnings)


def _constant(value):
    raise ValueError("nonstandard JSON constant")


def _json(handle, selection, version, bundle):
    cap = min(selection.options["cap"], bundle["limits"]["source_bytes"] - bundle["source_bytes"])
    if version[2] > cap:
        return {"status": "source_limit", "size_bytes": version[2], "source_ceiling": cap}, None
    raw = _read(handle, version[2], bundle)
    try:
        data = json.loads(raw, parse_float=_JsonNumber, parse_int=_JsonNumber, parse_constant=_constant)
    except (ValueError, UnicodeError, RecursionError):
        return {"status": "invalid_json"}, None
    fields = []
    for pointer in selection.options["pointers"]:
        value = data
        try:
            for part in pointer.split("/")[1:] if pointer else []:
                if any(part[i:i + 2] not in ("~0", "~1") for i, ch in enumerate(part) if ch == "~"):
                    raise ValueError()
                part = part.replace("~1", "/").replace("~0", "~")
                if isinstance(value, list):
                    if not part.isascii() or not part.isdigit() or (len(part) > 1 and part[0] == "0"):
                        raise KeyError()
                    value = value[int(part)]
                elif isinstance(value, dict):
                    value = value[part]
                else:
                    raise KeyError()
            fields.append(dict(pointer=pointer, status="ok", value=value))
        except (KeyError, IndexError):
            fields.append(dict(pointer=pointer, status="missing"))
        except ValueError:
            fields.append(dict(pointer=pointer, status="invalid_pointer"))
    return {"status": "complete", "fields": [], "omitted_fields": len(fields)}, fields


def emit(*selections, max_bytes=4096, max_source_bytes=65536):
    """Print one JSON bundle, within shared source/output byte limits. Return None."""
    if not isinstance(max_bytes, int) or max_bytes < 128:
        raise ValueError("max_bytes must be at least 128 (refusal envelope)")
    if not isinstance(max_source_bytes, int) or max_source_bytes < 0:
        raise ValueError("max_source_bytes must be nonnegative")
    if any(not isinstance(selection, _Selection) for selection in selections):
        raise TypeError("emit accepts text/json_fields selectors")
    bundle = dict(items=[], omitted={"from": 0, "count": len(selections), "reason": "output_budget"},
                  source_bytes=0, output_bytes=0,
                  limits={"output_bytes": max_bytes, "source_bytes": max_source_bytes})
    if len(_encoded(bundle).encode("utf-8")) > max_bytes:
        bundle = dict(status="output_limit", omitted_count=len(selections), source_bytes=0, output_bytes=0)
        print(_encoded(bundle), end="")
        return None
    for index, selection in enumerate(selections):
        before = bundle["source_bytes"]
        item = dict(index=index, path=selection.path, kind=selection.kind)
        details = None
        try:
            # Unbuffered regular files: the counter is actual bytes read, not requested bytes.
            with open(selection.path, "rb", buffering=0) as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode):
                    result = {"status": "not_regular_file"}
                else:
                    version = _version(info)
                    item["version"] = version
                    if selection.kind == "text":
                        result, details = _text(handle, selection, version, bundle)
                    else:
                        result, details = _json(handle, selection, version, bundle)
                    if _version(os.fstat(handle.fileno())) != version or _version(os.stat(selection.path)) != version:
                        result, details = {"status": "changed_source", "next": None}, None
                item.update(result)
        except OSError as error:
            item.update(status="unavailable", error=error.__class__.__name__, errno=error.errno)
        item["source_bytes"] = bundle["source_bytes"] - before
        bundle["items"].append(item)
        bundle["omitted"].update({"from": index + 1, "count": len(selections) - index - 1})

        def fits():
            return len(_encoded(bundle).encode("utf-8")) <= max_bytes

        if details is not None and selection.kind == "text":
            decoded, context = details
            item.update(_text_prefix(decoded, context, len(decoded)))
            if not fits():
                low, high = 0, len(decoded)
                while low < high:
                    middle = (low + high + 1) // 2
                    item.update(_text_prefix(decoded, context, middle))
                    if fits():
                        low = middle
                    else:
                        high = middle - 1
                item.update(_text_prefix(decoded, context, low))
        elif details is not None:
            for field_index, field in enumerate(details):
                item["fields"].append(field)
                item["omitted_fields"] = len(details) - field_index - 1
                if not fits():
                    item["fields"][-1] = dict(pointer=field["pointer"], status="value_limit")
                    item["status"] = "partial"
                    if not fits():
                        item["fields"].pop()
                        item["omitted_fields"] += 1
                        break
        if not fits():
            bundle["items"].pop()
            bundle["omitted"].update({"from": index, "count": len(selections) - index})
            break
    # Budget refusal may follow real I/O, so keep those source bytes in the envelope.
    rendered = _encoded(bundle)
    if len(rendered.encode("utf-8")) > max_bytes:
        bundle = dict(status="output_limit", omitted_count=len(selections),
                      source_bytes=bundle["source_bytes"], output_bytes=0)
        rendered = _encoded(bundle)
    print(rendered, end="")
    return None


def main():
    """Standalone: stage this file once, then pass a small JSON request on stdin."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-bytes", type=int, default=4096)
    parser.add_argument("--max-source-bytes", type=int, default=65536)
    args = parser.parse_args()
    request = json.load(sys.stdin)
    selections = []
    for entry in request:
        entry = dict(entry)
        kind, path = entry.pop("kind"), entry.pop("path")
        if kind not in ("text", "json"):
            parser.error("kind must be text or json")
        selections.append((text if kind == "text" else json_fields)(path, **entry))
    emit(*selections, max_bytes=args.max_bytes, max_source_bytes=args.max_source_bytes)


if __name__ == "__main__":
    main()
