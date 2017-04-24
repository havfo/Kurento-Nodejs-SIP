function NodeMediaHandler(session, options) {
  // Save this if you need to access the session for any reason.
  this.session = session;

  this.offer = null;
  this.answer = null;
}

NodeMediaHandler.prototype = {
  /*
   * This media handler does not support renegotiation,
   * so isReady doesn't really matter.
   */
  isReady: function() {
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


    onSuccess({
      body: '\r\n\r\n',
      contentType: 'application/sdp'
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
