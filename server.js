var SIP = require('sip.js');
var kurento = require('kurento-client');
var util = require('util');
var fs = require('fs');
var io = require('socket.io-client');

const ws_uri = 'ws://meet.akademia.no:8080/kurento';
const io_uri = 'https://meet.uninett.no';
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
    uri: 'mcu@meeting.akademia.no',
    password: 'DFOdH1abdsTDCqp',
    rel100: SIP.C.supported.SUPPORTED,
    wsServers: 'wss://meeting.akademia.no',
    turnServers: {
        urls: ['turn:videoturn@158.38.2.18:443?transport=tcp'],
        username: 'videoturn',
        password: 'videoturn'
    },
    stunServers: 'stun:stun.l.google.com:19302',
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

        this.getDescription = (onSuccess, onFailure, mediaHint) => {
            console.log('getDescription called!');

            joinRoom(roomName, sessionId, offer, (error, sdpAnswer) => {
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

        this.hasDescription = message => {
            return true;
        }

        this.setDescription = (message, onSuccess, onFailure) => {
            console.log('setDescription called!');
            offer = message.body;
            roomName = message.getHeader('X-Room');
            onSuccess();
        }

        return this;
    }
});

ua.on('invite', session => {
    console.log('INVITE arrived!');
    session.accept();
});


function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        console.log('KurentoClient already created');
        return callback(null, kurentoClient);
    }

    kurento(ws_uri, (error, _kurentoClient) => {
        console.log('Creating KurentoClient');
        if (error) {
            console.log('Coult not find media server at address ' + ws_uri);
            return callback('Could not find media server at address' + ws_uri +
                '. Exiting with error ' + error);
        }
        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

// Retrieve or create mediaPipeline
function prepareMediaPipeline(id, callback) {
    getKurentoClient((error, _kurentoClient) => {
        if (error) {
            return callback(error);
        }

        _kurentoClient.create('MediaPipeline', (error, _pipeline) => {
            if (error) {
                return callback(error);
            }
            console.log('Created MediaPipeline for room: ' + rooms[id].room + ' with ID: ' + id);

            rooms[id].MediaPipeline = _pipeline;
            rooms[id].MediaPipeline.create('Composite', (error, _composite) => {
                if (error) {
                    stop(id);
                    return callback(error);
                }
                console.log('Created Composite Hub for room: ' + rooms[id].room + ' with ID: ' + id);

                rooms[id].Composite = _composite;
                callback(null);
            });
        });
    });
}

function createRtpEndpoint(id, callback) {
    rooms[id].Composite.createHubPort((error, _hubPort) => {
        if (error) {
            return callback(error);
        }
        console.log('Created HubPort for RtpEndpoint in room: ' + rooms[id].room + ' with ID: ' + id);

        rooms[id].SIPClient.HubPort = _hubPort;
        rooms[id].MediaPipeline.create('RtpEndpoint', (error, _rtpEndpoint) => {
            if (error) {
                stop(id);
                return callback(error);
            }
            console.log('Created RtpEndpoint in room: ' + rooms[id].room + ' with ID: ' + id);

            rooms[id].SIPClient.RtpEndpoint = _rtpEndpoint;
            rooms[id].SIPClient.HubPort.connect(rooms[id].SIPClient.RtpEndpoint, error => {
                if (error) {
                    stop(id);
                    console.log('Error connecting ' + error);
                    return callback(error);
                }
                console.log('Connected HubPort to RtpEndpoint in room: ' + rooms[id].room + ' with ID: ' + id);

                callback(null);
            });
        });
    });
}

function createWebRtcEndpoint(id, pid, callback) {
    rooms[id].MediaPipeline.create('WebRtcEndpoint', (error, _webrtcEndpoint) => {
        console.info('Created WebRtcEndpoint in room: ' + rooms[id].room + ' with ID: ' + id);
        if (error) {
            removeParticipant(id, pid);
            return callback(error);
        }

        rooms[id].WebRTCClients[pid].WebRTCEndpoint = _webrtcEndpoint;

        if (rooms[id].WebRTCClients[pid].iceCandidateQueue) {
            while (rooms[id].WebRTCClients[pid].iceCandidateQueue.length) {
                let iceCandidate = rooms[id].WebRTCClients[pid].iceCandidateQueue.shift();
                rooms[id].WebRTCClients[pid].WebRTCEndpoint.addIceCandidate(iceCandidate.candidate);
            }
            delete rooms[id].WebRTCClients[pid].WebRTCEndpoint.iceCandidateQueue;
        }

        rooms[id].WebRTCClients[pid].WebRTCEndpoint.on('IceCandidateFound', event => {
            let candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
            rooms[id].RoomSocket.emit('iceCandidate', {
                pid: pid,
                candidate: candidate
            });
        });

        rooms[id].Composite.createHubPort((error, _hubPort) => {
            if (error) {
                removeParticipant(id, pid);
                return callback(error);
            }
            console.info('Created HubPort for WebRtcEndpoint in room: ' + rooms[id].room + ' with ID: ' + id);

            rooms[id].WebRTCClients[pid].HubPort = _hubPort;

            rooms[id].WebRTCClients[pid].WebRTCEndpoint.connect(rooms[id].WebRTCClients[pid].HubPort, error => {
                if (error) {
                    removeParticipant(id, pid);
                    return callback(error);
                }
                console.log('Connected WebRtcEndpoint to HubPort in room: ' + rooms[id].room + ' with ID: ' + id);

                rooms[id].SIPClient.RtpEndpoint.connect(rooms[id].WebRTCClients[pid].WebRTCEndpoint, error => {
                    if (error) {
                        removeParticipant(id, pid);
                        return callback(error);
                    }
                    console.log('Connected RtpEndpoint to WebRtcEndpoint: ' + pid + ' in room: ' + rooms[id].room + ' with ID: ' + id);
                    callback(null);
                });
            });
        });
    });
}

function createRoomSocket(id) {
    rooms[id].RoomSocket = io.connect(io_uri);
    rooms[id].RoomSocket.on('connection', socket => {
        console.log('RoomSocket connected to ' + io_uri + '/' + rooms[id].room);
    });

    rooms[id].RoomSocket.on('sdp', msg => {
        console.log('RoomSocket received sdpOffer from: ', msg.pid);
        if (msg.sdp.type == 'offer') {
            if (typeof(rooms[id].WebRTCClients[msg.pid]) == 'undefined') {
                rooms[id].WebRTCClients[msg.pid] = {};
            }

            createWebRtcEndpoint(id, msg.pid, error => {
                if (error) {
                    console.log('Error creating WebRtcEndpoint: ' + msg.pid + ' in room: ' + rooms[id].room + ' with ID: ' + id + ' error: ' + error);
                    removeParticipant(id, msg.pid);
                    return error;
                }

                rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint.processOffer(msg.sdp.sdp, (error, sdpAnswer) => {
                    if (error) {
                        console.log('Error processing offer for WebRtcEndpoint: ' + msg.pid + ' in room: ' + rooms[id].room + ' with ID: ' + id + ' error: ' + error);
                        removeParticipant(id, msg.pid);
                        return error;
                    }

                    rooms[id].RoomSocket.emit('sdp', {
                        pid: msg.pid,
                        sdp: {
                            sdp: sdpAnswer,
                            type: 'answer'
                        }
                    });

                    rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint.gatherCandidates(error => {
                        if (error) {
                            console.log('Error gathering ICE for WebRtcEndpoint: ' + msg.pid + ' in room: ' + rooms[id].room + ' with ID: ' + id + ' error: ' + error);
                            return error;
                        }
                    });
                });
            });
        } else if (msg.sdp.type == 'answer') {
            rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint.processAnswer(msg.sdp.sdp, error => {
                if (error) {
                    removeParticipant(id, msg.pid);
                    return error;
                }
            });
        }
    });

    rooms[id].RoomSocket.on('iceCandidate', msg => {
        if (typeof(rooms[id].WebRTCClients[msg.pid]) == 'undefined') {
            rooms[id].WebRTCClients[msg.pid] = {};
        }

        console.log('RoomSocket got iceCandidate from %s: %s', msg.pid, msg.candidate);
        let candidate = kurento.register.complexTypes.IceCandidate(msg.candidate);
        if (rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint) {
            rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint.addIceCandidate(candidate);
        } else {
            if (typeof(rooms[id].WebRTCClients[msg.pid].iceCandidateQueue) == 'undefined') {
                rooms[id].WebRTCClients[msg.pid].iceCandidateQueue = [];
            }
            rooms[id].WebRTCClients[msg.pid].iceCandidateQueue.push({
                candidate: candidate
            });
        }
    });

    rooms[id].RoomSocket.on('participantReady', msg => {
        if (typeof(rooms[id].WebRTCClients[msg.pid]) == 'undefined') {
            rooms[id].WebRTCClients[msg.pid] = {};
        }
        // Create WebRTCEndpoint
        console.log('RoomSocket got participantReady: ', msg);

        createWebRtcEndpoint(id, msg.pid, error => {
            if (error) {
                console.log('Error creating WebRtcEndpoint: ' + msg.pid + ' in room: ' + rooms[id].room + ' with ID: ' + id + ' error: ' + error);
                removeParticipant(id, msg.pid);
                return error;
            }

            rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint.generateOffer((error, sdpOffer) => {
                if (error) {
                    console.log('Error generating offer for WebRtcEndpoint: ' + msg.pid + ' in room: ' + rooms[id].room + ' with ID: ' + id + ' error: ' + error);
                    removeParticipant(id, msg.pid);
                    return error;
                }

                rooms[id].RoomSocket.emit('sdp', {
                    pid: msg.pid,
                    sdp: {
                        sdp: sdpOffer,
                        type: 'offer'
                    }
                });

                rooms[id].WebRTCClients[msg.pid].WebRTCEndpoint.gatherCandidates(error => {
                    if (error) {
                        console.log('Error gathering ICE for WebRtcEndpoint: ' + msg.pid + ' in room: ' + rooms[id].room + ' with ID: ' + id + ' error: ' + error);
                        return error;
                    }
                });
            });
        });
    });

    rooms[id].RoomSocket.on('bye', msg => {
        console.log('Got bye from WebRtcEndpoint: ' + msg.pid + ' in room: ' + rooms[id].room + ' with ID: ' + id);
        removeParticipant(id, msg.pid);
    });

    rooms[id].RoomSocket.on('participantDied', msg => {
        console.log(' WebRtcEndpoint: ' + msg.pid + ' died in room: ' + rooms[id].room + ' with ID: ' + id);
        removeParticipant(id, msg.pid);
    });

    rooms[id].RoomSocket.emit('ready', rooms[id].room);
}

function joinRoom(room, id, sdpOffer, callback) {
    rooms[id] = {
        room: room,
        SIPClient: {
            RtpEndpoint: null,
            HubPort: null,
            sdp: sdpOffer
        },
        WebRTCClients: {},
        MediaPipeline: null,
        Composite: null,
        RoomSocket: null
    }

    prepareMediaPipeline(id, error => {
        if (error) {
            console.log('Error preparing MediaPipeline in room: ' + rooms[id].room + ' with ID: ' + id + ' error: ' + error);
            stop(id);
            return callback(error);
        }

        createRtpEndpoint(id, error => {
            if (error) {
                console.log('Error creating RtpEndpoint in room: ' + rooms[id].room + ' with ID: ' + id + ' error: ' + error);
                stop(id);
                return callback(error);
            }

            rooms[id].SIPClient.RtpEndpoint.processOffer(sdpOffer, (error, sdpAnswer) => {
                if (error) {
                    stop(id);
                    console.log('Error processing offer from RtpEndpoint in room: ' + rooms[id].room + ' with ID: ' + id + ' error: ' + error);
                    return callback(error);
                }

                createRoomSocket(id);

                callback(null, sdpAnswer);
            });
        });
    });
}

function removeParticipant(id, pid) {
    if (rooms[id].WebRTCClients) {
        if (rooms[id].WebRTCClients[pid]) {
            if (rooms[id].WebRTCClients[pid].WebRTCEndpoint) {
                rooms[id].WebRTCClients[pid].WebRTCEndpoint.release();
            }

            if (rooms[id].WebRTCClients[pid].HubPort) {
                rooms[id].WebRTCClients[pid].HubPort.release();
            }

            delete rooms[id].WebRTCClients[pid];
        }
    }
}

function stop(id) {
    if (rooms[id]) {
        if (rooms[id].RoomSocket) {
            rooms[id].RoomSocket.emit('bye');
            rooms[id].RoomSocket.disconnect();
        }

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
