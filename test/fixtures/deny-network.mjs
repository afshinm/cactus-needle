import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

function denied() {
  throw new Error('Network access attempted during offline inference.');
}
globalThis.fetch = denied;
net.Socket.prototype.connect = denied;
net.connect = denied;
net.createConnection = denied;
tls.connect = denied;
http.request = denied;
http.get = denied;
https.request = denied;
https.get = denied;
syncBuiltinESMExports();
