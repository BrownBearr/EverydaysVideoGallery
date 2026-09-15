===============================================================================
  EVERDAYS VIDEO WALL - GALLERY SETUP
  10 screens, synced, served from your laptop over the local network
===============================================================================

THE IDEA
--------
Your laptop becomes the video source. The screens load everything from it over
the gallery wifi instead of from the internet.

Why: all synced screens play the same clip at the same moment, so they all
request the same file at the same instant. Ten screens at full quality is about
48 Mbps, and on a heavy clip over 100 Mbps - enough to black out most of the
wall on a normal gallery connection. Over the local network that same traffic
is nothing.

Once the download is done, the show does not need the internet at all.


===============================================================================
  PART 1 - THE NIGHT BEFORE, AT HOME (on your own wifi)
===============================================================================

Do NOT do this at the gallery. It is an 8.6 GB download.

  1. Open Terminal.

  2. Run these, one at a time:

       cd ~/everdays-video
       git pull
       npm run build
       npm run local:fetch

  3. Wait. It prints progress as it goes.

     If it fails or you stop it, just run "npm run local:fetch" again - it
     skips everything already downloaded and picks up where it left off.

  4. Check you have the space: it needs ~8.6 GB free.

     Smaller option: "node scripts/serve-local.mjs --fetch --quality 480"
     downloads only the small copies (~0.7 GB). Lower quality, but if disk
     space or time is tight it is a fine fallback.


===============================================================================
  PART 2 - AT THE GALLERY
===============================================================================

  1. Connect the laptop to the gallery wifi.

     If there is an ethernet port, plug the laptop in instead. Better - see
     TIPS below.

  2. In Terminal:

       cd ~/everdays-video
       caffeinate -i npm run local:serve

     "caffeinate -i" stops the laptop going to sleep and killing the show.

  3. macOS will ask whether to allow incoming network connections.
     Click ALLOW. (If you miss it: System Settings > Network > Firewall >
     Options, and allow node.)

  4. It prints a URL like:

       http://192.168.1.113:8080/?sync=1&cdn=http://192.168.1.113:8080/clips

     The numbers WILL be different from this example. Use what it prints.

  5. TEST IT ON ONE SCREEN FIRST (see PART 3).

  6. Once that works, open the SAME URL on all 10 screens.
     Press Enter on each for fullscreen.

     Add &fill=1 to the end for full-bleed (crops to fill the screen).

  7. Leave the Terminal window open for the whole show.
     Ctrl-C stops the server.


===============================================================================
  PART 3 - THE ONE TEST THAT MATTERS  (do this before setting up all 10)
===============================================================================

Open the printed URL on ONE screen.

  VIDEO PLAYS      -> You are done. Set up the other 9. No router needed.

  TIMES OUT / WONT LOAD -> The wifi has "client isolation" turned on, which
                           stops devices talking to each other. Fix it one of
                           these ways:

    a) Ask the venue for the staff/non-guest wifi password, or ask them to
       turn off AP isolation. Usually the quickest fix.

    b) If there is an ETHERNET PORT: make the laptop the wifi network itself.
       System Settings > General > Sharing > Internet Sharing
         Share your connection from: Ethernet
         To computers using:         Wi-Fi
       Turn it on, set a network name and password, then put the laptop and
       all 10 screens on THAT network. Re-run step 2 and use the new URL.

    c) Travel router: plug it in, put the laptop and all 10 screens on it.
       Nothing else needed - the router does not need internet.

A travel router is NOT required. It is only insurance for this one situation.
If you can visit the venue beforehand, run this test then and you will know.


===============================================================================
  TIPS
===============================================================================

WIRE THE LAPTOP IF YOU CAN
  If the laptop AND the screens are all on wifi, every video crosses the air
  twice and shares the same airtime - around 96 Mbps at full quality. An
  ethernet cable from the laptop to the router halves that.
  Wifi-only? Add &quality=480 to every screen's URL. Airtime drops to almost
  nothing and it is completely stable.

THE IP ADDRESS CHANGES
  It is assigned by the router, so check the URL the server prints each time
  you set up. Do not write it down the night before.

ALL SCREENS NEED THE IDENTICAL URL
  Sync is derived from the URL. If one screen has a different &styles= filter
  or a different &quality=, it runs its own schedule and will not match.

USEFUL KEYS (on any screen)
  Enter  fullscreen
  f      open the filter / display panel
  z      fill screen on/off
  s      sync on/off
  Esc    close the panel

  After 4 seconds of no mouse or keyboard, the cursor and all on-screen text
  fade out on their own.

IF ONE SCREEN LOOKS SOFTER THAN THE OTHERS
  It dropped to the smaller files on its own because it was struggling. Pin
  every screen to the same thing by adding &quality=720 (or &quality=480) to
  all of them.

IF A SCREEN GOES BLACK
  Reload the page. It will rejoin the others mid-clip, already in sync.


===============================================================================
  QUICK REFERENCE
===============================================================================

  At home:     cd ~/everdays-video
               git pull
               npm run build
               npm run local:fetch

  At gallery:  cd ~/everdays-video
               caffeinate -i npm run local:serve

  Then open the printed URL on every screen. Press Enter for fullscreen.

===============================================================================
