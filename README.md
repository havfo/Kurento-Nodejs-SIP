# Connect to WebRTC using SIP and Kurento
This project uses SIP.js in Node.js, and Kurento media server to enable SIP endpoints to connect to peer-to-peer WebRTC meetings. The WebRTC meeting server in question is [Knockplop](https://github.com/so010/knockplop).

## Architecture
![SIP Kurento architecture](https://raw.githubusercontent.com/havfo/Kurento-Nodejs-SIP/master/images/sipnode.png "SIP Kurento architecture")

## Installation
You need a SIP registrar/proxy that supports SIP over websockets. You need an account on this SIP server to register to. Configure credentials in `server.js`. The room it joins is specified by the `X-Room` SIP-header. You need a Kurento media server installation. Configure the settings in `server.js`.

You can install Kamailio as the SIP registrar/proxy using the [WEBRTC-to-SIP](https://github.com/havfo/WEBRTC-to-SIP) and use the configuration file `config/kamailio.cfg` in this repository instead. Create the Node.js SIP user with `kamctl add mcu DFOdH1abdsTDCqp`.

To install:
```bash
npm install
```

## Running
To run:
```bash
npm start
```
The Node.js server registers to the SIP server and waits for incoming calls. On an incoming call the server joins the corresponding room on the knockplop server specified in `server.js`.
