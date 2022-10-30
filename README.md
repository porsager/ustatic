# ustatic

A static file serve handler for uWebSockets.js with range and compression support.

```js
import uws from 'uWebSockets.js'

const app = uws.App()
app.get(ustatic('./'))
app.listen(1337)
```
