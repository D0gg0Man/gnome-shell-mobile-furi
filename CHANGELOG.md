48.mobile.0

 - Rebased on GNOME 48
 - Newly opened windows are now put on the next workspace, instead of the last one
 - Popups are now shifted up while the OSK is visible
 - Popups no longer grab input from the compositor, so overview can be opened while popups are open now
 - Added mobile OSK layouts for digits, phone, and number input hints
 - Removed the MPRIS seeking buttons in the quicksettings music indicator again

46-mobile.1

 - Added text shadow to texts in the overview
 - Improved desktop-mode style of the overview
 - Added back the patch for utilization clamping that was forgotten in .0
 - Removed the "ѕ" letter from Serbian keyboard layout
 - Improved the Persian keyboard layout ([Sohrab Behdani] https://gitlab.gnome.org/verdre/gnome-shell-mobile/-/merge_requests/5)
 - Fixed stretched wallpaper in the overview when rotating the screen
 - Stopped showing auto-suspend notification for chassis type "handset" and "tablet"
 - Layout-switcher key in the OSK is now hidden when there's only a single layout
 - Patches to run Aliendalvik are now included
 - Fixed inhibiting of initial (un-dimming) event while the screen is dimmed
 - Slightly adjusted curves for perceived brightness
 - Added Packit config for auto-building RPMs from Fedora COPR ([Christian Glombek] https://gitlab.gnome.org/verdre/gnome-shell-mobile/-/merge_requests/4)
 - Switched to using the default OSK layout on phone for EMAIL and URL input purpose
 - Stopped claiming the accelerometer sensor while it's not needed (eg. when screen is off or rotation is locked)

46-mobile-0

 - Initial release
