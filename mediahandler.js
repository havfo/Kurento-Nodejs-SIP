function NodeMediaHandler(session, options) {
    // Save this if you need to access the session for any reason.
    this.session = session;

    this.id = null;
    this.mediapipeline = null;
    this.rtpendpoint = null;
    this.offer = null;
    this.answer = null;
}

const ws_uri = "ws://meet.akademia.no:8080/kurento";

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
function getMediaPipeline(callback) {
    if (mediaPipeline !== null) {
        console.log("MediaPipeline already created");
        return callback(null, mediaPipeline);
    }
    getKurentoClient(function(error, _kurentoClient) {
        if (error) {
            return callback(error);
        }
        _kurentoClient.create('MediaPipeline', function(error, _pipeline) {
            console.log("creating MediaPipeline");
            if (error) {
                return callback(error);
            }
            this.mediapipeline = _pipeline;
            callback(null, mediaPipeline);
        });
    });
}

// Create a RTP end point
function createRtpEndPoint(callback) {
    getMediaPipeline(function(error, _pipeline) {
        if (error) {
            return callback(error);
        }
        _pipeline.create('RtpEndpoint', function(error, _RtpEndpoint) {
            console.info("Creating createRtpEndpoint");
            if (error) {
                return callback(error);
            }

            _pipeline.create("FaceOverlayFilter",
                function(error, filter) {
                    if (error) return onError(error);

                    console.log("Got FaceOverlayFilter");
                    var offsetXPercent = -0.4;
                    var offsetYPercent = -1;
                    var widthPercent = 1.5;
                    var heightPercent = 1.5;

                    console.log("Setting overlay image");
                    filter.setOverlayedImage("https://fosstveit.no/hat.png", offsetXPercent,
                        offsetYPercent, widthPercent,
                        heightPercent,
                        function(error) {
                            if (error) return onError(error);
                            console.log("Set overlay image");
                        });

                    console.log("Connecting ...");
                    _RtpEndpoint.connect(filter, function(error) {
                        if (error) return onError(error);

                        console.log("WebRtcEndpoint --> filter");

                        filter.connect(_RtpEndpoint, function(error) {
                            if (error) return onError(error);

                            console.log("Filter --> WebRtcEndpoint");
                        });
                    });
                });

            callback(null, _RtpEndpoint);
        });
    });
}

// Add a RTP client
function addClient(id, sdp, callback) {
    this.id = id;

    createRtpEndPoint(function(error, _RtpEndpoint) {
        if (error) {
            console.log("Error creating RtpEndPoint " + error);
            return callback(error);
        }
        this.rtpendpoint = _RtpEndpoint;

        this.rtpendpoint.processOffer(sdp, function(error, sdpAnswer) {
            if (error) {
                stop(id);
                console.log("Error processing offer " + error);
                return callback(error);
            }
            callback(null, sdpAnswer);
        });
    });
}

// Stop and remove a RTP client
function stop() {
    if (this.rtpendpoint) {
        this.rtpendpoint.release();
        this.rtpendpoint = null;
    }

    if (this.mediaPipeline) {
        this.mediaPipeline.release();
        this.mediaPipeline = null;
    }
}

NodeMediaHandler.prototype = {
    /*
     * This media handler does not support renegotiation,
     * so isReady doesn't really matter.
     */
    isReady: function() {
        return true;
    },

    isSupported: function() {
        return true;
    },

    /*
     * Not much to do on cleanup.
     */
    close: function() {
        return true;
    },

    /*
     * The following methods are lingering dependencies that we plan
     * to clean up in the future.  If the media server provides implementations,
     * you could add the behavior to these for them to take effect.  Otherwise,
     * empty function are necessary to satisfy the dependency right now.
     */
    render: new Function(),
    mute: new Function(),
    unmute: new Function(),

    getDescription: function(onSuccess, onFailure, mediaHint) {
        console.log("getDescription called!");
        /*
         * Here, you would asynchronously request an offer or answer
         * from your media server.  This probably involves creating a
         * room or session, and requesting SDP for that session.
         *
         * In this example, we aren't using a media server, so we will
         * create a custom media description using JSON.  The media hint will
         * determine if we throw Rock, Paper, or Scissors.
         *
         * We use setTimeout to force it to be asynchronous.
         */

        addClient(1234, this.offer, function(error, sdpAnswer) {
            if (error) {
                onFailure(new SIP.Exceptions.NotSupportedError('Kurento failure'));
            } else {
                this.answer = sdpAnswer;
                onSuccess({
                    body: sdpAnswer,
                    contentType: 'application/sdp'
                });
            }
        });
    },

    hasDescription: function(message) {
        return true;
    },

    setDescription: function(message, onSuccess, onFailure) {
        console.log("setDescription called!");

        this.offer = message.body;

        onSuccess();
        /*
         * Here, we receive the description of the remote end's offer/answer.
         * In normal WebRTC calls, this would be an RTCSessionDescription with
         * a String body that can be passed to the WebRTC core.  You will probably
         * just need to pass that to your media engine.
         *
         * In this simple example, our "media description" is simply a
         * String gesture indication the other end chose.
         */
        // Set their gesture based on the remote description
        /* var description = message.body;
        if (['rock', 'paper', 'scissors'].indexOf(description) < 0) {
            this.timeout = setTimeout(function() {
                delete this.timeout;
                onFailure(new SIP.Exceptions.NotSupportedError('Gesture unsupported'));
            }.bind(this), 0);
        }

        this.theirGesture = description;
        this.checkGestures();

        this.timeout = setTimeout(function() {
            delete this.timeout;
            onSuccess();
        }.bind(this), 0); */
    }
};

module.exports = {
    nodeMediaHandlerFactory: function(session, options) {
        return new NodeMediaHandler(session, options);
    }
}
