# Locked browser sites

Written 2026-11-01. This describes Herdr Panels as it behaves in this tree. It is not a scan of other programs on the machine.

## What lock does

Locking a panel makes the panels API refuse to read it, type into it, click it, or take its screenshot. Agent control is the one switch for those calls, whether they come from the CLI or the API. It starts on. Off leaves the viewer token able to arrange the desk. The viewer token cannot turn Agent control on, and it cannot approve an unlock. Those stay in the desktop window.

Locking a **browser** panel also locks that panel's site.

- `https://mail.google.com` and `https://accounts.google.com` are the same site, `google.com`.
- `https://www.youtube.com` is a different site, even when the same Google account can reach it.
- `https://news.bbc.co.uk` is `bbc.co.uk`, not every `.co.uk` site.
- `https://foo.github.io` does not lock `bar.github.io`.

While that lock is on, the API refuses to open a panel on the site, change a panel onto the site, split a panel onto the site, or read, drive, or screenshot any panel already showing the site. A page that redirects onto the site is treated the same way when the desktop window can see the navigation: the other panel does not follow the redirect. If the check cannot reach the viewer, the page is left alone and the API still refuses to return what it loaded.

The locked panel itself stays usable. Clicks in that window are the person's. The desk uses the same API as an agent, so the desk also cannot open a second panel on that site until the lock is cleared. Unlocking one panel clears the site lock from that panel only. Another locked panel on the same site keeps the site closed.

This is an API rule. It stops the workaround where an agent opens a new panel on a site that is already signed in and then reads or drives that panel. It does not hide the cookie files. A program running as you can still read the browser profile and request the site on its own. Administrator rights are not required for that on Windows.

A browser tab, as opposed to the desktop window, cannot cancel a redirect inside the page. The API still refuses to read or drive the site.

## What a private cookie folder did not do

An earlier build gave a locked desktop panel its own WebView2 profile. That profile did not take the existing sign-in out of the shared profile. A new panel opened on the same site was still signed in. The private folder was also a normal directory in the user profile, so a terminal running as you could read it. That split has been removed. Locked and unlocked browser panels share one profile again. Lock does not sign the panel out, and it does not reload it.

## Packaging that isolates a browser

Flatpak, Snap, Windows MSIX, and the macOS App Sandbox can give a browser its own directory. They isolate the **packaged app** from the rest of the computer. They do not hide that directory from other programs you run.

### Flatpak

Flatpak runs an app with a private view of the filesystem. The app's data lives under `~/.var/app/<app-id>/` in the user's home. A browser packaged this way (Firefox and Chromium are published this way) keeps its cookies in that directory. It does not see the host browser's profile unless the Flatpak is granted that folder.

The manifest decides what the sandbox may touch: network, windows, and filesystem paths such as `home` or `host`. An app with `filesystem=host` is not isolated. Portals (`xdg-desktop-portal`) let a sandboxed app ask the person to pick a file instead of reading the whole home directory.

A terminal running as you, outside the Flatpak, can read `~/.var/app/<app-id>/`. Flatpak does not encrypt that folder against the user who owns it. Putting Herdr Panels in a Flatpak would give its browser a private directory relative to other sandboxed apps. Herdr's agent, if it runs as a normal terminal on the host, could still open that directory.

Snap is the same shape. A snap's data is under `~/snap/<name>/`. The host user can read it. A snap with the `home` interface can read the user's files.

### Windows

An MSIX package gives the app an identity and a folder under `AppData\Local\Packages\<package family>\`. AppContainer limits what that packaged process may read, based on capabilities declared for the package. The interactive user can still open the Packages folder. Packaging Herdr Panels this way does not stop a normal terminal from reading the package directory.

Windows Sandbox is different. It is a separate lightweight machine. A process inside it does not see the host profile. That is a real boundary, and it is heavy: the agent would not see the desk either unless the files it needs are deliberately shared.

### macOS

The App Sandbox puts an app's files in `~/Library/Containers/<bundle-id>/`. Without an entitlement or a file the person picked, the sandboxed app cannot wander the home directory. Other programs you run outside the sandbox can read the container. Hardened Runtime can stop a debugger from attaching. It does not hide the files.

## The direction that holds

The operating system can refuse a process access to a folder or to another process. Herdr Panels cannot declare that refusal against a program that is already running as you.

The useful packaging is on the **agent**, not on the browser:

- Start the agent inside a Flatpak or Snap with no access to the Herdr Panels config directory and no access to the desktop window's browser profile. That profile is the app's data directory on that system.
- On Windows, start it with a restricted token or an AppContainer that cannot open those directories or the panels process. Child programs have to inherit that restriction, so it cannot start a normal shell as you.
- On macOS, an App Sandbox or a separate user has the same job.
- A separate Windows user, or a VM, is the strong version of the same idea.

Your own windows keep your normal rights. The panels API lock, including the site lock, is then the rule the agent actually has to live with, because it cannot step around it by reading the profile.

## Easy gaps still open

These are real, and they are smaller than the same-user terminal. They are not done in this change.

1. **Plugin grants are re-read from disk.** `plugin-grants.json` is loaded on each use. A shell that can write that file can widen a plugin. Panel locks do not work that way: this process keeps the lock list in memory. Grants could use the same pattern, with the install and uninstall commands updating that memory.
2. **The viewer token can still open and retarget panels that are not on a locked site.** Arrange stays available when Agent control is off. Moving browser open and address changes behind Agent control would shrink that. The site lock covers only a site that a locked browser panel is showing.
3. **`plugin install --yes` uses the viewer token.** An agent that can run the CLI can install a plugin and accept its prompt.
4. **The desk page includes the viewer token.** A program that can request the local page can arrange the desk. It still cannot turn Agent control on or approve an unlock.
5. **Screen capture of the window.** The API will not screenshot a locked panel or a locked site. The operating system can still capture a window unless the window opts out of capture. That opt-out does not protect cookie files.
6. **A site is not an account.** Locking `google.com` does not lock `youtube.com`. A login that lives in `localStorage` on a site the API can still open is still reachable through that other site.
