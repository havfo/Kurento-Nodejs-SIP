var SIP = require('sip.js');
var kurento = require('kurento-client');
var util = require('util');
var fs = require('fs');
var nodemediahandler = require('./mediahandler.js')

var ua = new SIP.UA({
    traceSip: true,
    register: true,
    uri: "websip@webrtcsip.uninett.no",
    password: "websip",
    rel100: SIP.C.supported.UNSUPPORTED,
    wsServers: "wss://webrtcsip.uninett.no",
    turnServers: {
        urls: ["turn:videoturn@158.38.2.18:443?transport=tcp"],
        username: "videoturn",
        password: "videoturn"
    },
    stunServers: "stun:stun.l.google.com:19302",
    mediaHandlerFactory: nodemediahandler.nodeMediaHandlerFactory
});

ua.on('invite', function(session) {
    console.log("INVITE arrived!");
    session.accept();
});
