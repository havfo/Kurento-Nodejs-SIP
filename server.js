var SIP = require('sip.js');
var kurento = require('kurento-client');
var util = require('util');
var fs = require('fs');
var io = require('socket.io-client');
var sdpparser = require('rtc-sdp');

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
    mediaHandlerFactory: function() {
        var sessionId = nextUniqueId();
        var roomName = null;
        var offer = null;
        var answer = null;

        this.isReady = function isReady() {
            return true;
        }

        this.close = function() {
            console.log('Closing SIP dialog: ' + sessionId + ' to room: ' + roomName);
            stop(sessionId);
        }

        this.render = new Function();
        this.mute = new Function();
        this.unmute = new Function();

        this.getDescription = (onSuccess, onFailure, mediaHint) => {
            console.log('Getdescription called for dialog: ' + sessionId + ' to room: ' + roomName);

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
            offer = message.body;
            roomName = message.getHeader('X-Room');
            console.log('Setdescription called for dialog: ' + sessionId + ' to room: ' + roomName);
            onSuccess();
        }

        return this;
    }
});

ua.on('invite', session => {
    session.accept();
});


function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        console.log('KurentoClient already created');
        return callback(null, kurentoClient);
    }

    kurento(ws_uri, (error, _kurentoClient) => {
        if (error) {
            console.log('Coult not find media server at address ' + ws_uri);
            return callback('Could not find media server at address' + ws_uri +
                '. Exiting with error ' + error);
        }
        console.log('Created KurentoClient, connected to: ' + ws_uri);
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

function createSIPEndpoint(id, callback) {
    rooms[id].Composite.createHubPort((error, _hubPort) => {
        if (error) {
            return callback(error);
        }
        console.log('Created HubPort for WebRtcEndpoint in room: ' + rooms[id].room + ' with ID: ' + id);

        rooms[id].SIPClient.HubPort = _hubPort;
        rooms[id].MediaPipeline.create('WebRtcEndpoint', (error, _webRtcEndpoint) => {
            if (error) {
                stop(id);
                return callback(error);
            }
            console.log('Created WebRtcEndpoint in room: ' + rooms[id].room + ' with ID: ' + id);

            rooms[id].SIPClient.WebRtcEndpoint = _webRtcEndpoint;

            rooms[id].SIPClient.HubPort.connect(rooms[id].SIPClient.WebRtcEndpoint, error => {
                if (error) {
                    stop(id);
                    console.log('Error connecting ' + error);
                    return callback(error);
                }
                console.log('Connected HubPort to WebRtcEndpoint in room: ' + rooms[id].room + ' with ID: ' + id);

                callback(null);
            });
        });
    });
}

function createWebRtcEndpoint(id, pid, callback) {
    rooms[id].MediaPipeline.create('WebRtcEndpoint', (error, _webrtcEndpoint) => {
        if (error) {
            removeParticipant(id, pid);
            return callback(error);
        }
        console.info('Created WebRtcEndpoint in room: ' + rooms[id].room + ' with ID: ' + id);

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

                rooms[id].SIPClient.WebRtcEndpoint.connect(rooms[id].WebRTCClients[pid].WebRTCEndpoint, error => {
                    if (error) {
                        removeParticipant(id, pid);
                        return callback(error);
                    }
                    console.log('Connected WebRtcEndpoint to WebRtcEndpoint: ' + pid + ' in room: ' + rooms[id].room + ' with ID: ' + id);
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
                    console.log('Error processing answer for WebRtcEndpoint: ' + msg.pid + ' in room: ' + rooms[id].room + ' with ID: ' + id + ' error: ' + error);
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
        console.log('RoomSocket got participantReady: ', msg.pid);

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
        console.log('WebRtcEndpoint: ' + msg.pid + ' died in room: ' + rooms[id].room + ' with ID: ' + id);
        removeParticipant(id, msg.pid);
    });

    console.log('Emitting ready in room: ' + rooms[id].room + ' with ID: ' + id);
    rooms[id].RoomSocket.emit('ready', rooms[id].room);
}

function joinRoom(room, id, sdpOffer, callback) {
    rooms[id] = {
        room: room,
        SIPClient: {
            WebRtcEndpoint: null,
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

        createSIPEndpoint(id, error => {
            if (error) {
                console.log('Error creating SIPEndpoint in room: ' + rooms[id].room + ' with ID: ' + id + ' error: ' + error);
                stop(id);
                return callback(error);
            }

            rooms[id].SIPClient.WebRtcEndpoint.on('IceCandidateFound', event => {
                event.candidate.candidate = 'a=' + event.candidate.candidate;

                rooms[id].SIPClient.sdp.addIceCandidate(event.candidate);
            });

            rooms[id].SIPClient.WebRtcEndpoint.on('IceGatheringDone', event => {
                console.info('gathering done');

                callback(null, rooms[id].SIPClient.sdp.toString());
            });

            rooms[id].SIPClient.WebRtcEndpoint.processOffer(sdpOffer, (error, sdpAnswer) => {
                if (error) {
                    stop(id);
                    console.log('Error processing offer from WebRtcEndpoint in room: ' + rooms[id].room + ' with ID: ' + id + ' error: ' + error);
                    return callback(error);
                }

                rooms[id].SIPClient.sdp = sdpparser(sdpAnswer);

                createRoomSocket(id);

                rooms[id].SIPClient.WebRtcEndpoint.gatherCandidates(error => {
                    if (error) {
                        return error;
                    }

                    console.info('gathering candidates');
                });
            });
        });
    });
}

function removeParticipant(id, pid) {
    if (rooms[id].WebRTCClients) {
        if (rooms[id].WebRTCClients[pid]) {
            if (rooms[id].WebRTCClients[pid].WebRTCEndpoint) {
                console.log('Releasing WebRtcEndpoint: ' + pid + ' in room: ' + rooms[id].room + ' with ID: ' + id);
                rooms[id].WebRTCClients[pid].WebRTCEndpoint.release();
            }

            if (rooms[id].WebRTCClients[pid].HubPort) {
                console.log('Releasing WebRtcEndpoint HubPort: ' + pid + ' in room: ' + rooms[id].room + ' with ID: ' + id);
                rooms[id].WebRTCClients[pid].HubPort.release();
            }

            delete rooms[id].WebRTCClients[pid];
        }
    }
}

function stop(id) {
    if (rooms[id]) {
        if (rooms[id].RoomSocket) {
            console.log('Emitting bye in room: ' + rooms[id].room + ' with ID: ' + id);
            rooms[id].RoomSocket.emit('bye');
            rooms[id].RoomSocket.disconnect();
        }

        if (rooms[id].SIPClient.WebRtcEndpoint) {
            console.log('Releasing WebRtcEndpoint: ' + id + ' in room: ' + rooms[id].room);
            rooms[id].SIPClient.WebRtcEndpoint.release();
        }

        if (rooms[id].SIPClient.HubPort) {
            console.log('Releasing WebRtcEndpoint HubPort: ' + id + ' in room: ' + rooms[id].room);
            rooms[id].SIPClient.HubPort.release();
        }

        if (rooms[id].WebRTCClients) {
            while (rooms[id].WebRTCClients.length) {
                let WebRTCClient = rooms[id].WebRTCClients.shift();

                if (WebRTCClient.WebRTCEndpoint) {
                    console.log('Releasing WebRtcEndpoint: ' + id + ' in room: ' + rooms[id].room);
                    WebRTCClient.WebRTCEndpoint.release();
                }

                if (WebRTCClient.HubPort) {
                    console.log('Releasing WebRtcEndpoint HubPort: ' + id + ' in room: ' + rooms[id].room);
                    WebRTCClient.HubPort.release();
                }
            }
        }

        if (rooms[id].Composite) {
            console.log('Releasing Composite: ' + id + ' in room: ' + rooms[id].room);
            rooms[id].Composite.release();
        }

        if (rooms[id].MediaPipeline) {
            console.log('Releasing MediaPipeline: ' + id + ' in room: ' + rooms[id].room);
            rooms[id].MediaPipeline.release();
        }

        delete rooms[id];
    }
}
