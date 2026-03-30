# scribe-sync

Sync your Kindle Scribe highlights and vocabulary to your computer — directly in your browser. No software to install, no account required.

**[Try it →](https://drewmwhite.github.io/scribe-sync)**

## How it works

1. Open the page in Chrome or Edge
2. Plug your Kindle Scribe into your computer via USB
3. Click **Connect Kindle** and select your device
4. Your vocabulary and highlights are displayed — click **Download** to save each file

Everything runs locally in your browser over WebUSB. No data leaves your machine.

## Local development

WebUSB requires a secure context — opening `index.html` directly as a `file://` URL will not work. Serve the project over HTTP instead:

```sh
cd scribe-sync
python3 -m http.server 8000
```

Then open `http://localhost:8000` in Chrome or Edge. `localhost` is treated as a secure context so WebUSB works normally.

## Browser support

Requires Chrome or Edge (any platform). Firefox and Safari do not support WebUSB.

## Platform notes

**macOS** — Works out of the box.

**Linux** — Add a udev rule once to allow non-root USB access:

```sh
echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="1949", MODE="0664", GROUP="plugdev"' \
  | sudo tee /etc/udev/rules.d/60-kindle.rules \
  && sudo udevadm control --reload-rules \
  && sudo udevadm trigger
sudo usermod -aG plugdev $USER   # then log out and back in
```

**Windows** — Windows installs an MTP driver that blocks WebUSB. You must replace it with WinUSB using [Zadig](https://zadig.akeo.ie/):

1. Open Zadig → Options → List All Devices
2. Select your Kindle
3. Choose **WinUSB** → **Replace Driver**

After this, the Kindle will no longer appear in File Explorer as a portable device. You can revert via Device Manager.

## Deployment

The site is a static HTML/JS/CSS app with no build step. Deploy by pushing to GitHub and enabling **GitHub Pages** (Settings → Pages → Deploy from branch → `main`).

## License

MIT
