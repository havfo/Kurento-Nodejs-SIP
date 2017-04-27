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

            joinRoom(roomName, sessionId, offer, function(error, sdpAnswer) {
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

                    rooms[id].SIPClient.HubPort.connect(rooms[id].SIPClient.RtpEndpoint, function(error) {
                        if (error) {
                            stop(id);
                            console.log("Error connecting " + error);
                            return callback(error);
                        }

                        rooms[id].SIPClient.RtpEndpoint.processOffer(sdp, (error, sdpAnswer) => {
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
                                    rooms[id].MediaPipeline.create('WebRtcEndpoint', function(error, _webrtcEndpoint) {
                                        console.info("Creating createWebRtcEndpoint");
                                        if (error) {
                                            removeParticipant(id, msg.pid);
                                            return error;
                                        }

                                        rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint = _webrtcEndpoint;

                                        if (rooms[id].WebRTCClients[msg.pid].iceCandidateQueue) {
                                            while (rooms[id].WebRTCClients[msg.pid].iceCandidateQueue.length) {
                                                let iceCandidate = rooms[id].WebRTCClients[msg.pid].iceCandidateQueue.shift();

                                                rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint.addIceCandidate(iceCandidate);
                                            }

                                            delete rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint.iceCandidateQueue;
                                        }

                                        rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint.on('OnIceCandidate', event => {
                                            let candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
                                            rooms[id].RoomSocket.emit('iceCandidate', {
                                                id: msg.pid,
                                                candidate: candidate
                                            });
                                        });

                                        rooms[id].Composite.createHubPort(function(error, _hubPort) {
                                            console.info("Creating hubPort");
                                            if (error) {
                                                removeParticipant(id, msg.pid);
                                                return error;
                                            }

                                            rooms[id].WebRTCClients[msg.pid].HubPort = _hubPort;

                                            rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint.connect(rooms[id].WebRTCClients[msg.pid].HubPort, function(error) {
                                                if (error) {
                                                    removeParticipant(id, msg.pid);
                                                    return error;
                                                }

                                                rooms[id].SIPClient.RtpEndpoint.connect(rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint, function(error) {
                                                    if (error) {
                                                        removeParticipant(id, msg.pid);
                                                        return error;
                                                    }

                                                    rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint.processOffer(msg.sdp, function(error, returnsdp) {
                                                        if (error) {
                                                            removeParticipant(id, msg.pid);
                                                            return error;
                                                        }

                                                        var returnmsg = {};
                                                        returnmsg.sdp = returnsdp;
                                                        returnmsg.pid = msg.pid;

                                                        rooms[id].RoomSocket.emit('sdp', returnmsg);

                                                        rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint.gatherCandidates(error => {
                                                            if (error) {
                                                                return error;
                                                            }
                                                        });
                                                    });
                                                });
                                            });
                                        });
                                    });
                                } else if (msg.sdp.type == 'answer') {
                                    rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint.processAnswer(msg.sdp, function(error) {
                                        if (error) {
                                            removeParticipant(id, msg.pid);
                                            return error;
                                        }
                                    });
                                }
                            });

                            rooms[id].RoomSocket.on('iceCandidate', function(msg) {
                                console.log('got iceCandidate from %s: %s', msg.pid, msg.candidate);
                                let candidate = kurento.register.complexTypes.IceCandidate(msg.candidate);
                                if (rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint) {
                                    rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint.addIceCandidate(candidate);
                                } else {
                                    rooms[id].WebRTCClients[msg.pid].iceCandidateQueue.push({
                                        candidate: candidate
                                    });
                                }
                            });

                            rooms[id].RoomSocket.on('participantReady', function(msg) {
                                // Create WebRTCEndpoint
                                console.log('got participantReady:', msg);

                                rooms[id].WebRTCClients[msg.pid] = {};
                                rooms[id].MediaPipeline.create('WebRtcEndpoint', function(error, _webrtcEndpoint) {
                                    console.info("Creating createWebRtcEndpoint");
                                    if (error) {
                                        removeParticipant(id, msg.pid);
                                        return error;
                                    }

                                    rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint = _webrtcEndpoint;

                                    if (rooms[id].WebRTCClients[msg.pid].iceCandidateQueue) {
                                        while (rooms[id].WebRTCClients[msg.pid].iceCandidateQueue.length) {
                                            let iceCandidate = rooms[id].WebRTCClients[msg.pid].iceCandidateQueue.shift();

                                            rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint.addIceCandidate(iceCandidate);
                                        }

                                        delete rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint.iceCandidateQueue;
                                    }

                                    rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint.on('OnIceCandidate', event => {
                                        let candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
                                        rooms[id].RoomSocket.emit('iceCandidate', {
                                            id: msg.pid,
                                            candidate: candidate
                                        });
                                    });

                                    rooms[id].Composite.createHubPort(function(error, _hubPort) {
                                        console.info("Creating hubPort");
                                        if (error) {
                                            removeParticipant(id, msg.pid);
                                            return error;
                                        }

                                        rooms[id].WebRTCClients[msg.pid].HubPort = _hubPort;

                                        rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint.connect(rooms[id].WebRTCClients[msg.pid].HubPort, function(error) {
                                            if (error) {
                                                removeParticipant(id, msg.pid);
                                                return error;
                                            }

                                            rooms[id].SIPClient.RtpEndpoint.connect(rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint, function(error) {
                                                if (error) {
                                                    removeParticipant(id, msg.pid);
                                                    return error;
                                                }

                                                rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint.generateOffer(function(error, sdpoffer) {
                                                    if (error) {
                                                        removeParticipant(id, msg.pid);
                                                        return error;
                                                    }

                                                    var returnmsg = {};
                                                    returnmsg.sdp = sdpoffer;
                                                    returnmsg.pid = msg.pid;

                                                    rooms[id].RoomSocket.emit('sdp', returnmsg);

                                                    rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint.gatherCandidates(error => {
                                                        if (error) {
                                                            return error;
                                                        }
                                                    });
                                                });
                                            });
                                        });
                                    });
                                });
                            });

                            rooms[id].RoomSocket.on('bye', function(msg) {
                                console.log('got bye from:', msg.pid);
                                removeParticipant(id, msg.pid);
                            });

                            rooms[id].RoomSocket.on('participantDied', function(msg) {
                                console.log('received participantDied from server: removing participant from my participantList');
                                removeParticipant(id, msg.pid);
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

function removeParticipant(id, pid) {
    if (rooms[id].WebRTCClients) {
        if (rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint) {
            rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint.release();
        }

        if (rooms[id].WebRTCClients[msg.pid].HubPort) {
            rooms[id].WebRTCClients[msg.pid].HubPort.release();
        }

        delete rooms[id].WebRTCClients[msg.pid];
    }
}

function stop(id) {
    if (rooms[id]) {
        rooms[id].RoomSocket.emit('bye');

        if (rooms[id].SIPClient.RtpEndpoint) {
            rooms[id].SIPClient.RtpEndpoint.release();
        }

        if (rooms[id].SIPClient.HubPort) {
            rooms[id].SIPClient.HubPort.release();
        }

        if (rooms[id].WebRTCClients) {
            while (rooms[id].WebRTCClients.length) {
                let WebRTCClient = rooms[id].WebRTCClients.shift();

                if (WebRTCClient.WebRTCEndpoint) {
                    WebRTCClient.WebRTCEndpoint.release();
                }

                if (WebRTCClient.HubPort) {
                    WebRTCClient.HubPort.release();
                }
            }
        }

        if (rooms[id].Composite) {
            rooms[id].Composite.release();
        }

        if (rooms[id].MediaPipeline) {
            rooms[id].MediaPipeline.release();
        }

        delete rooms[id];
    }
}
