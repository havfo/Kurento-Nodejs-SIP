// Simple registrar - redirector
//

var SIP = require('sip.js');
var kurento = require('kurento-client');
var util = require('util');
var fs = require('fs');
var nodemediahandler = require('./mediahandler.js')

let ua = new SIP.UA({
    traceSip: true,
    register: true,
    uri: "websip@webrtcsip.uninett.no",
    password: "websip",
    rel100: SIP.C.supported.SUPPORTED,
    wsServers: "wss://webrtcsip.uninett.no:443",
    turnServers: {
        urls: ["stun:stun.l.google.com:19302", "turn:videoturn@158.38.2.18:443?transport=tcp"],
        username: "videoturn",
        password: "videoturn"
    },
    stunServers: "stun:stun.l.google.com:19302",
    mediaHandlerFactory: nodemediahandler.nodeMediaHandlerFactory
});

ua.start();
