Install node.js (18+)

In folder of the project:
```bash
npm i
npx playwright install
```

Fill users.txt

Start:
```bash
npx zoom-multi --url "https://us05web.zoom.us/j/123321123" --browser=chromium
```
#xmD0Y7

All args you can find there:
```js
const args = arg({
  "--url": String,
  "--users": String,
  "--browser": String,     // chromium | firefox | webkit
  "--headless": Boolean,
  "--concurrency": Number, // параллельные сессии
  "--timeout": Number,     // мс до "устал ждать" при коннекте
  "--keep-open": Boolean,  // не закрывать браузеры после входа
  "--no-audio": Boolean,   // НЕ запрашивать доступ к устройствам (для тестов)
  "--auto-join-audio": Boolean, // автоматически нажать "Join Audio by Computer"
  "--enforce-mute": Boolean,    // следить и гарантировать выключенные микрофон/видео
  "-u": "--url",
  "-f": "--users",
  "-b": "--browser",
  "-h": "--headless",
  "-c": "--concurrency",
  "-t": "--timeout"
});
```
