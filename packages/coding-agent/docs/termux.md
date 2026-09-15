# Termux (Android) notes

These notes describe inherited [Termux](https://termux.dev/) integration points. They are not a claim that Base Context 1.0.0 has been validated on Android. Node's native SQLite support, Python setup, and optional native dependencies must work in your environment.

## Prerequisites

1. Install [Termux](https://github.com/termux/termux-app#installation) from a currently supported distribution.
2. Install [Termux:API](https://github.com/termux/termux-api#installation) for clipboard and device integrations.
3. Install a Node version satisfying `^22.12.0 || >=23.3.0` and arrange a compatible Python runtime as described in [installation](installation.md#python-setup).

The repository and build commands are the same as on other source installations:

```bash
git clone https://github.com/BaseModelAI/base-context.git
cd base-context
npm ci
npm run build:source
node packages/coding-agent/dist/bundle/cli.js
```

## Clipboard Support

Clipboard operations use `termux-clipboard-set` and `termux-clipboard-get` when running in Termux. The Termux:API app must be installed for these to work.

Image clipboard is not supported on Termux (the `ctrl+v` image paste feature will not work).

## Example AGENTS.md for Termux

Create `~/.base-context/AGENTS.md` to help the agent understand the Termux environment:

````markdown
# Agent Environment: Termux on Android

## Location
- **OS**: Android (Termux terminal emulator)
- **Home**: `/data/data/com.termux/files/home`
- **Prefix**: `/data/data/com.termux/files/usr`
- **Shared storage**: `/storage/emulated/0` (Downloads, Documents, etc.)

## Opening URLs
```bash
termux-open-url "https://example.com"
```

## Opening Files
```bash
termux-open file.pdf          # Opens with default app
termux-open -c image.jpg      # Choose app
```

## Clipboard
```bash
termux-clipboard-set "text"   # Copy
termux-clipboard-get          # Paste
```

## Notifications
```bash
termux-notification -t "Title" -c "Content"
```

## Device Info
```bash
termux-battery-status         # Battery info
termux-wifi-connectioninfo    # WiFi info
termux-telephony-deviceinfo   # Device info
```

## Sharing
```bash
termux-share -a send file.txt # Share file
```

## Other Useful Commands
```bash
termux-toast "message"        # Quick toast popup
termux-vibrate                # Vibrate device
termux-tts-speak "hello"      # Text to speech
termux-camera-photo out.jpg   # Take photo
```

## Notes
- Termux:API app must be installed for `termux-*` commands
- Use `pkg install termux-api` for the command-line tools
- Storage permission needed for `/storage/emulated/0` access
````

## Limitations

- **No image clipboard**: Termux clipboard API only supports text
- **No native binaries**: Some optional native dependencies (like the clipboard module) are unavailable on Android ARM64 and are skipped during installation
- **Storage access**: To access files in `/storage/emulated/0` (Downloads, etc.), run `termux-setup-storage` once to grant permissions

## Troubleshooting

### Clipboard not working

Ensure both apps are installed:
1. Termux (from GitHub or F-Droid)
2. Termux:API (from GitHub or F-Droid)

Then install the CLI tools:
```bash
pkg install termux-api
```

### Permission denied for shared storage

Run once to grant storage permissions:
```bash
termux-setup-storage
```

### Node.js installation issues

If npm fails, try clearing the cache:
```bash
npm cache clean --force
```
