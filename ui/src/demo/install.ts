// The website demo's backend in place of the Tauri/WebSocket one, before the app makes a call;
// and, framed in the website's page, word to the page once the app is up (frame.ts).
import { setTransportOverride } from '../api/transport';
import { bootDemo } from './boot';
import { reportToParent, whenGraphShown } from './frame';
import { HANDLERS } from './handlers';
import { createDemoTransport } from './transport';

const runtime = bootDemo();
setTransportOverride(createDemoTransport(runtime, HANDLERS));
reportToParent(window, runtime, () => whenGraphShown(document));
