# expo-serve-sim

Expo Metro integration for [`serve-sim`](../serve-sim). Mounts the serve-sim preview UI on your Expo dev server.

```sh
npm install --save-dev expo-serve-sim serve-sim
```

Customize `metro.config.js` (`bunx expo customize`) and wrap the Metro config:

```js
const { getDefaultConfig } = require("expo/metro-config");
const { withSimServe } = require("expo-serve-sim");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

module.exports = withSimServe(config);
// or: module.exports = withSimServe(config, { basePath: "/.sim" });
```

Start the simulator stream in one terminal:

```sh
npx serve-sim --detach
```

Run Expo in another terminal and open the preview:

```sh
npx expo start
```

Open `http://localhost:8081/.sim` to view and control the booted simulator. `expo-serve-sim` only mounts the preview middleware; it does not start or stop `serve-sim`.
