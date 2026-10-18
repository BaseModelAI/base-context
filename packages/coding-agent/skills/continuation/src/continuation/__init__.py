"""Explicit external blocker holds through the Base Context host bridge."""

from __future__ import annotations

from typing import Literal, TypedDict, cast

from rlm import host_request


class ExternalBlockerHold(TypedDict):
    kind: Literal["external_blocker"]
    reason: str


class _ContinuationState(TypedDict):
    status: Literal["ready", "blocked_external"]


class ContinuationStatus(_ContinuationState, total=False):
    hold: ExternalBlockerHold


async def block(*, reason: str) -> ContinuationStatus:
    """Hold automatic continuation for an external blocker with no independent work.

    The hold is explicit. Ordinary input does not resume continuation; only the
    user or host can resume it.
    """
    if not isinstance(reason, str):
        raise TypeError(f"reason must be str, got {type(reason).__name__}")
    if not reason.strip():
        raise ValueError("reason must not be empty")
    return cast(ContinuationStatus, await host_request("continuation_block", {"reason": reason}))


async def status() -> ContinuationStatus:
    """Read whether automatic continuation is ready or externally blocked."""
    return cast(ContinuationStatus, await host_request("continuation_status", {}))
