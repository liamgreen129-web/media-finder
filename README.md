# Media Finder

A personal MEGA browser for iPhone: pick a folder, see every photo or video in it and all its subfolders as large thumbnails, sort them, and tap to play without losing your place.

## Put it online (free, one time)

The app has to live at an https address so your iPhone can install it. GitHub Pages is free and works from a phone:

1. Sign in at github.com (create a free account if needed).
2. Tap **+ → New repository**, name it `media-finder`, set it to **Public**, tick **Add a README**, and create it.
3. In the repo, tap **Add file → Upload files** and upload everything in this folder (unzip it first in the Files app).
4. Go to **Settings → Pages**, set Source to **Deploy from a branch**, Branch **main**, folder **/ (root)**, and save.
5. After a minute your app is at `https://YOUR-USERNAME.github.io/media-finder/`.

Your MEGA login is never stored in the repo. It only exists on your phone.

## Add it to your iPhone

1. Open the address in **Safari**.
2. Tap **Share → Add to Home Screen → Add**.
3. Open it from the home screen and sign in. Close and reopen it once after the first sign-in so video streaming switches on.

## Using it

- **Folder button** (top): choose which folder to search. Everything underneath it is included.
- **Chips**: Videos, Photos, Photos & videos, Audio, All files.
- **Sort**: newest, oldest, largest, smallest, name, or grouped by folder.
- **XL / L / M / S**: thumbnail size.
- **Filter by name**: matches file names and folder names.
- **Link button** (top): paste a shared MEGA file or folder link to search inside it, no sign-in needed. Recent links are remembered; the ✕ takes you back to your own drive.
- Tap a tile to open it. Use Prev / Next (or swipe on photos) to move through the results. Back returns you to the same spot in the grid.

## Notes

- Videos stream and decrypt on your phone as they play, so they start quickly and you can scrub. iPhone browsers play MP4, MOV and M4V. MKV, AVI and WMV won't play.
- Thumbnails come from the ones MEGA already made when the files were uploaded. Files uploaded without one show their file type instead.
- Playing videos uses your MEGA transfer quota, same as the official app.
- "Stay signed in" keeps a MEGA session on your phone (not your password). Sign out with the button at the top right.
- Open with `?demo` on the end of the address to see the layout with fake files.

Built on [megajs](https://github.com/qgustavor/mega) (MIT licence, included as `mega.js`).
