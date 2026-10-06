const net = require("node:net");
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0] : args;
  const first = options[0];
  const host = typeof first === "object" ? first.host : typeof options[1] === "string" ? options[1] : undefined;
  if (host && !["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error(`Offline tests blocked external connection to ${host}`);
  }
  return connect.apply(this, args);
};
