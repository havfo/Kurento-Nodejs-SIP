var SIP = require('sip.js');
var kurento = require('kurento-client');
var util = require('util');
var fs = require('fs');
var io = require('socket.io-client');

const ws_uri = "ws://meet.akademia.no:8080/kurento";
var kurentoClient = null;

var idCounter = 0;
var rooms = {};

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
        var roomName = null;
        var offer = null;
        var answer = null;

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

            joinRoom(roomName, sessionId, this.offer, function(error, sdpAnswer) {
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
            offer = message.body;
            roomName = message.getHeader("X-Room");
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

function joinRoom(room, id, sdp, callback) {
    rooms[id] = {
        room: room,
        id: id,
        SIPClient: {
            RtpEndpoint: null,
            HubPort: null
        },
        WebRTCClients: {},
        MediaPipeline: null,
        Composite: null,
        RoomSocket: null
    }

    createMediaPipeline(function(error, _pipeline) {
        if (error) {
            console.log("Error creating MediaPipeline " + error);
            stop(id);
            return callback(error);
        }

        rooms[id].MediaPipeline = _pipeline;

        rooms[id].MediaPipeline.create('Composite', function(error, _composite) {
            console.log("creating Composite");
            if (error) {
                stop(id);
                return callback(error);
            }
            rooms[id].Composite = _composite;

            rooms[id].Composite.createHubPort(function(error, _hubPort) {
                console.info("Creating hubPort");
                if (error) {
                    return callback(error);
                }
                rooms[id].SIPClient.HubPort = _hubPort;

                rooms[id].MediaPipeline.create('RtpEndpoint', function(error, _rtpEndpoint) {
                    console.info("Creating createRtpEndpoint");
                    if (error) {
                        stop(id);
                        return callback(error);
                    }

                    rooms[id].SIPClient.RtpEndpoint = _rtpEndpoint;

                    rooms[id].SIPClient.HubPort.connect(rooms[id].SIPClient.RtpEndpoint, , function(error) {
                        if (error) {
                            stop(id);
                            console.log("Error connecting " + error);
                            return callback(error);
                        }

                        rooms[id].SIPClient.RtpEndpoint.processOffer(sdp, function(error, sdpAnswer) {
                            if (error) {
                                stop(id);
                                console.log("Error processing offer " + error);
                                return callback(error);
                            }

                            rooms[id].RoomSocket = io.connect('https://meet.uninett.no');
                            rooms[id].RoomSocket.on('connection', function(socket) {
                                console.log('Socket connected!');
                            });

                            rooms[id].RoomSocket.on('sdp', function(msg) {
                                // Only create answers in response to offers
                                console.log('received sdp from', msg.pid);
                                if (msg.sdp.type == 'offer') {
                                    rooms[id].WebRTCClients[msg.pid] = {};
                                    rooms[id].WebRTCClients[msg.pid].peerConnection.setRemoteDescription(msg.sdp);
                                    rooms[id].WebRTCClients[msg.pid].peerConnection.createAnswer().then(function(description) {
                                        createdDescription(description, msg.pid)
                                    }).catch(errorHandler);
                                } else if (msg.sdp.type == 'answer') {
                                    rooms[id].WebRTCClients[msg.pid].peerConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp))
                                }
                            });

                            rooms[id].RoomSocket.on('iceCandidate', function(msg) {
                                console.log('got iceCandidate from %s: %s', msg.pid, msg.candidate.candidate);
                                rooms[id].WebRTCClients[msg.pid].peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(errorHandler);
                            });

                            rooms[id].RoomSocket.on('participantReady', function(msg) {
                                console.log('got participantReady:', msg);

                                rooms[id].WebRTCClients[msg.pid] = {};

                                rooms[id].WebRTCClients[msg.pid].peerConnection = new RTCPeerConnection(tempPeerConnectionConfig);

                                rooms[id].WebRTCClients[msg.pid].peerConnection.onicecandidate = function(event) {
                                    gotIceCandidate(event.candidate, msg.pid)
                                };

                                rooms[id].WebRTCClients[msg.pid].peerConnection.addStream(localStream);
                                rooms[id].WebRTCClients[msg.pid].peerConnection.createOffer().then(function(description) {
                                    createdDescription(description, msg.pid)
                                }).catch(errorHandler);
                            });

                            rooms[id].RoomSocket.on('bye', function(msg) {
                                console.log('got bye from:', msg.pid);
                                deleteParticipant(msg.pid);
                            });

                            rooms[id].RoomSocket.on('participantDied', function(msg) {
                                console.log('received participantDied from server: removing participant from my participantList');
                                deleteParticipant(msg.pid);
                            });

                            rooms[id].RoomSocket.emit('ready', rooms[id].room);

                            callback(null, sdpAnswer);
                        });
                    });
                });
            });
        });
    });
}

function stop(id) {
    if (rooms[id]) {
        rooms[id].RoomSocket.emit('bye');
        if (rooms[id].RtpEndpoint) {
            rooms[id].RtpEndpoint.release();
        }
        if (rooms[id].MediaPipeline) {
            rooms[id].MediaPipeline.release();
        }
        delete rooms[id];
    }
}
