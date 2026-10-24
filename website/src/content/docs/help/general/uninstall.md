---
title: Uninstalling & Data Removal
description: How to completely remove Magimail or Magical, erase stored accounts and sessions, and clean up local caches.
---

Magimail and Magical store your Google login sessions, preferences, encrypted local event and message caches, and widget data strictly on your Mac.

If you want to remove an app temporarily or wipe all traces of it permanently, you can use the built-in clean removal command or manually remove the directories.

## Clean Removal Command (Recommended)

Both applications include a native removal tool that cleanly unregisters background services, dismisses notifications, terminates processes, and removes all stored data.

1. Open **Magimail** or **Magical**.
2. Click the application name in the macOS menu bar (e.g. **Magimail**).
3. Select **Remove All App Data and Quit…** (located directly above "Quit").
4. A confirmation dialogue will appear:
   - _"Remove all app data and quit?"_
   - _"Magimail will remove the accounts and Google sessions stored on this Mac, along with its caches, preferences, login item and notifications. It will then quit. This cannot be undone."_
5. Click **Remove All Data and Quit**.

:::danger
Removing app data cannot be undone. The accounts and Google sessions go with it, so you will sign in again on the next launch.
:::

### What This Cleans Up

When you confirm data removal, the app cleanly wipes:

- **Login Sessions & Accounts**: Signs out of all connected Google accounts and removes all saved login credentials and profiles from your Mac.
- **Downloaded Data & Caches**: Clears all saved email messages, calendar events, search indexes, and temporary web data.
- **Desktop Widgets & Extensions**: Erases widget data and resets Share extension caches.
- **Settings & Preferences**: Resets all app preferences, themes, and customised account colours.
- **Login Items & Notifications**: Removes the app from macOS Login Items and dismisses any remaining notification banners.

Once the data is removed, the app quits automatically. You can then drag the app from `/Applications` to the Trash.

---

## Manual Removal by Hand

If you have already deleted the application from `/Applications` or prefer to remove data manually using Terminal or Finder, delete the following paths:

### Magimail

```sh
# 1. Quit the application if running
killall Magimail MagimailHelper 2>/dev/null

# 2. Remove application support files, sessions, and caches
rm -rf ~/Library/Application\ Support/Magimail
rm -rf ~/Library/Logs/Magimail
rm -rf ~/Library/Preferences/com.alexhaslam.magimail.plist
rm -rf ~/Library/Caches/com.alexhaslam.magimail*
rm -rf ~/Library/WebKit/com.alexhaslam.magimail*
rm -rf ~/Library/HTTPStorages/com.alexhaslam.magimail*
rm -rf ~/Library/Saved\ Application\ State/com.alexhaslam.magimail.savedState

# 3. Remove the shared widget containers and extension sandboxes
rm -rf ~/Library/Group\ Containers/group.com.alexhaslam.magimail
rm -rf ~/Library/Containers/com.alexhaslam.magimail.*

# 4. Flush macOS preferences cache
defaults delete com.alexhaslam.magimail 2>/dev/null

# 5. Remove the application bundle
rm -rf /Applications/Magimail.app
```

### Magical

```sh
# 1. Quit the application if running
killall Magical MagicalHelper 2>/dev/null

# 2. Remove application support files, sessions, and caches
rm -rf ~/Library/Application\ Support/Magical
rm -rf ~/Library/Logs/Magical
rm -rf ~/Library/Preferences/com.alexhaslam.magical.plist
rm -rf ~/Library/Caches/com.alexhaslam.magical*
rm -rf ~/Library/WebKit/com.alexhaslam.magical*
rm -rf ~/Library/HTTPStorages/com.alexhaslam.magical*
rm -rf ~/Library/Saved\ Application\ State/com.alexhaslam.magical.savedState

# 3. Remove the shared widget containers and extension sandboxes
rm -rf ~/Library/Group\ Containers/group.com.alexhaslam.magical
rm -rf ~/Library/Containers/com.alexhaslam.magical.*

# 4. Flush macOS preferences cache
defaults delete com.alexhaslam.magical 2>/dev/null

# 5. Remove the application bundle
rm -rf /Applications/Magical.app
```

---

## Login Items & Extensions Cleanup

If you dragged the app to the Trash without running the removal tool:

1. Open **System Settings** on your Mac.
2. Navigate to **General → Login Items & Extensions**.
3. Under **Open at Login**, select Magimail or Magical and click the minus (`–`) button.
4. Under **Extensions**, disable any remaining Share or Widget extension entries if prompted.
