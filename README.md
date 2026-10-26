# homebridge-displaydeck

Switch your display setup from HomeKit. This [Homebridge](https://homebridge.io) plugin adds **one switch for every display
profile** saved in DisplayDeck, a Windows app that saves monitor layouts and audio devices as named profiles ("Desk",
"Living Room", "Den TV"). Say "Hey Siri, turn on Living Room", tap a switch in the Home app, or use one in an automation, and
the PC changes its screens and sound output.

- **One switch per profile.** Turn one on and DisplayDeck applies that profile. The switch for the active profile reads on, and
  the others read off, even when you change profiles on the PC, from your phone or from a Stream Deck.
- **Keeps itself up to date.** The plugin checks DisplayDeck every few seconds. Save a profile and its switch appears in the
  Home app; delete one and its switch goes away. Nothing to reconfigure.
- **Honest about the PC being off.** When the PC cannot be reached the switches show "No Response" instead of a wrong state, and
  recover by themselves. An unreachable PC never deletes a switch.
- **Optional "Undo layout" button** that goes back to the display layout from before the last change.

## Requirements

- DisplayDeck running on a Windows PC, with **Allow other devices (phone)** turned on in its tray menu. That is the setting
  that lets other devices on your home network reach it.
- Homebridge 1.8 or newer (including 2.x) on a computer or device on the same network, running Node.js 18.20, 20.15, 22.10 or
  newer (Homebridge 2 needs Node.js 22 or 24).

## Install

From the Homebridge UI, search for **DisplayDeck** and install it, or from a terminal on the Homebridge machine:

```sh
npm install -g homebridge-displaydeck
```

To install a copy you built yourself, run `npm pack` in this folder and install the `.tgz` it makes:

```sh
npm install -g ./homebridge-displaydeck-0.1.0.tgz
```

## Set up

1. On the PC, right-click the DisplayDeck tray icon and turn on **Allow other devices (phone)**. Windows may ask for permission once.
2. Open DisplayDeck's **Phone** tab and look at the link under the QR code. It ends with `?key=` followed by a long string of
   letters and numbers. That string is the **access key**.
3. In the Homebridge UI, open the DisplayDeck plugin settings and fill in:
   - **PC address**: the PC's IP address on your network (for example `192.168.1.50`). Give the PC a fixed address in your
     router so this does not change.
   - **Access key**: the key from step 2.
4. Restart Homebridge. The profile switches appear in the log, then in the Home app (add the Homebridge bridge there first if you have not).

Or edit `config.json` directly:

```json
{
  "platforms": [
    {
      "platform": "DisplayDeck",
      "name": "DisplayDeck",
      "host": "192.168.1.50",
      "accessKey": "0123456789abcdef0123456789abcdef"
    }
  ]
}
```

### All settings

| Setting | Default | What it does |
| --- | --- | --- |
| `host` | (required) | The PC's IP address or name. |
| `accessKey` | (empty) | The key from DisplayDeck's phone link. Leave empty only if Homebridge runs on the same PC. |
| `port` | `8765` | DisplayDeck's port. |
| `pollSeconds` | `5` | How often to check for added, deleted and switched profiles (2 to 300). |
| `profiles` | (all) | Only expose these profiles. Names must match DisplayDeck exactly. |
| `namePrefix` | (none) | Text added in front of every switch name. |
| `undoSwitch` | `false` | Adds an "Undo layout" button. |

## How it behaves

- **Turning a switch on** applies the profile (layout first, then its audio settings). The switch shows your choice at once;
  applying takes a few seconds, and the plugin settles on what DisplayDeck reports when it is done. If the apply fails, the
  switches go back to what the PC really shows and the reason is in the Homebridge log.
- **Turning the active profile off** does nothing: a layout cannot be un-applied, so its switch turns back on. Turning on a
  different profile is how you change layouts.
- **Added and deleted profiles** come and go within a few seconds. A deleted profile's switch is removed only after DisplayDeck
  has been reachable and missing it on two checks in a row, so a brief glitch cannot wipe your switches.
- **Renaming a profile** in DisplayDeck looks like deleting one and adding another, so the new switch appears in the Home app
  without the old one's room or automations. Set those up again after a rename.
- **Names.** HomeKit wants names that start and end with a letter or number, so a profile called `Desk!` shows as `Desk`.

## Troubleshooting

- **"No Response" in the Home app.** The PC is off or asleep, DisplayDeck is not running, or **Allow other devices (phone)** is
  turned off. The Homebridge log says which. Check the PC address and that Windows Firewall allowed DisplayDeck (the tray menu has
  **Allow through firewall...**).
- **"DisplayDeck refused the access key".** Copy the key again from the Phone page. If you turned phone access off and on, the key
  changes.
- **No switches appear.** DisplayDeck has no saved profiles yet, or `profiles` lists names that do not match.

## Security

The access key lets whoever has it use DisplayDeck's web page from your network: switching profiles, undoing layouts and changing
audio devices. It cannot change DisplayDeck's settings or delete profiles. It is stored in plain text in Homebridge's
`config.json`, so treat that file like a password. The plugin talks to DisplayDeck over plain HTTP on your own network; do not
expose DisplayDeck to the internet.

## Development

```sh
npm install
npm run check   # type-check, build and run the tests
```

The tests run the plugin against a stand-in DisplayDeck server and the real HAP library, so switches behave as they would for
HomeKit. Node.js 22 or 24 is needed to run them (they use Node's built-in test runner and TypeScript support).

## License

[MIT](LICENSE)
