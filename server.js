var SIP = require('sip.js');
var kurento = require('kurento-client');
var util = require('util');
var fs = require('fs');

const ws_uri = "ws://meet.akademia.no:8080/kurento";
var kurentoClient = null;

var idCounter = 0;
var clients = {};

function nextUniqueId() {
    idCounter++;
    return idCounter.toString();
}

var ua = new SIP.UA({
    traceSip: true,
    register: true,
    uri: "websip@webrtcsip.uninett.no",
    password: "websip",
    rel100: SIP.C.supported.SUPPORTED,
    wsServers: "wss://webrtcsip.uninett.no",
    turnServers: {
        urls: ["turn:videoturn@158.38.2.18:443?transport=tcp"],
        username: "videoturn",
        password: "videoturn"
    },
    stunServers: "stun:stun.l.google.com:19302",
    mediaHandlerFactory: function() {
        var sessionId = nextUniqueId();

        this.isReady = function isReady() {
            console.log('Is ready!!!!');
            return true;
        }

        this.close = function() {
            console.log('Is close!!!!');
            stop(sessionId);
        }

        this.render = new Function();
        this.mute = new Function();
        this.unmute = new Function();

        this.getDescription = function(onSuccess, onFailure, mediaHint) {
            console.log("getDescription called!");

            addClient(sessionId, this.offer, function(error, sdpAnswer) {
                if (error) {
                    onFailure();
                } else {
                    onSuccess({
                        body: sdpAnswer,
                        contentType: 'application/sdp'
                    });
                }
            });
        }

        this.hasDescription = function(message) {
            return true;
        }

        this.setDescription = function(message, onSuccess, onFailure) {
            console.log("setDescription called!");
            this.offer = message.body;
            onSuccess();
        }

        return this;
    }
});

ua.on('invite', function(session) {
    console.log("INVITE arrived!");
    session.accept();
});


function getKurentoClient(callback) {
    console.log("getKurentoClient");
    if (kurentoClient !== null) {
        console.log("KurentoClient already created");
        return callback(null, kurentoClient);
    }

    kurento(ws_uri, function(error, _kurentoClient) {
        console.log("creating kurento");
        if (error) {
            console.log("Coult not find media server at address " + ws_uri);
            return callback("Could not find media server at address" + ws_uri +
                ". Exiting with error " + error);
        }
        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

// Retrieve or create mediaPipeline
function createMediaPipeline(callback) {
    getKurentoClient(function(error, _kurentoClient) {
        if (error) {
            return callback(error);
        }
        _kurentoClient.create('MediaPipeline', function(error, _pipeline) {
            console.log("creating MediaPipeline");
            if (error) {
                return callback(error);
            }
            mediaPipeline = _pipeline;
            callback(null, mediaPipeline);
        });
    });
}

function addClient(id, sdp, callback) {

    clients[id] = {
        id: id,
        RtpEndpoint: null,
        MediaPipeline: null
    }

    createMediaPipeline(function(error, _pipeline) {
        if (error) {
            console.log("Error creating MediaPipeline " + error);
            return callback(error);
        }

        clients[id].MediaPipeline = _pipeline;

        clients[id].MediaPipeline.create('RtpEndpoint', function(error, _RtpEndpoint) {
            console.info("Creating createRtpEndpoint");
            if (error) {
                return callback(error);
            }

            clients[id].RtpEndpoint = _RtpEndpoint;

            clients[id].RtpEndpoint.connect(clients[id].RtpEndpoint, function(error) {
                if (error) {
                    return callback(error);
                }

                clients[id].RtpEndpoint.processOffer(sdp, function(error, sdpAnswer) {
                    if (error) {
                        stop(id);
                        console.log("Error processing offer " + error);
                        return callback(error);
                    }

                    callback(null, sdpAnswer);
                });
            });
        });
    });
}

function stop(id) {
    if (clients[id]) {
        if (clients[id].RtpEndpoint) {
            clients[id].RtpEndpoint.release();
        }
        if (clients[id].MediaPipeline) {
            clients[id].MediaPipeline.release();
        }
        delete clients[id];
    }
}
