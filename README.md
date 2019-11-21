# shh-signal

**Decentralized signalling for [simple-peer](https://github.com/feross/simple-peer) using the [Ethereum Whisper protocol](https://github.com/ethereum/wiki/wiki/Whisper-Overview).**

**Still an open research project, but it works! If you have a local node, [try the demo!](https://t-mullen.github.io/shh-signal)**

## Features
- All signalling data is sent over Whisper. Only STUN servers are used.
- Video, voice, data and all the features of WebRTC work as normal.
- Adapts almost all client features from [`simple-signal`](https://github.com/t-mullen/simple-signal).
- Takes advantage of Whisper's probablistic routing to help obscure identity until a WebRTC connection is accepted.

## Install
With Browserify:
```
npm install shh-signal --save
```

Without Browserify:
```html
<script src="dist/shh-signal-client.js"></script>
```

You also need access to the global `Web3` object. `shh-signal` is currently only tested with the version in `dist/web3.min.js`.

You will also need a local Ethereum node with Websockets JSON-RPC and Whisper enabled.

### Example
A common signaling scheme is to connect two clients by having one client "call" the ID of another.

Client:
```javascript
const web3 = new Web3(new Web3.providers.WebsocketProvider('ws://localhost:8546')) // setup web3
const signalClient = new ShhSignalClient(web3) // setup shh-signal

const allIDs = []
signalClient.on('discover', async (newID) => {
	allIDs.push(newID)

  const id = await promptUserForID(allIDs) // Have the user choose an ID to connect to (you define this)
  const { peer } = await signalClient.connect(id) // connect to target client
  peer // this is a fully-signaled simple-peer object (initiator side)
})

signalClient.on('request', async (request) => {
  const { peer } = await request.accept() // Accept the incoming request
  peer // this is a fully-signaled simple-peer object (non-initiator side)
})
```

See `example.js` for a more comprehensive example.

## Client API

### `signalClient = new SignalClient(web3, [options])`
Create a new signalling client.

Required `web3` is a **web3** instance with a provider that supports both Whisper and subscriptions (such as a `WebsocketProvider` connected to a local [`geth`](https://geth.ethereum.org/downloads/) node started with the `--shh` option).

Options:

- `connectionTimeout: number = 10000`: Defines the time to wait to establish a connection.
- `roomPassword": string = ""`: A secret passphrase used to encrypt connection messages.

### `signalClient.id`
The identifying string for this client's socket. `null` until discovery completes. Consists of 2 public keys `pubKey` and `sig`, used for encryption and signing respectively.

### `signalClient.discover(discoveryData)`
Initiate discovery.

`discoveryData` is any discovery data to be sent to all peers with the room password.

### `{ peer, metadata } = await signalClient.connect(id, [metadata], [peerOptions])`
Request to connect to another client. Returns a Promise.

`id` is the `signalClient.id` of the other client.

Optional `metadata` is any serializable object to be passed along with the request.

Optional `peerOptions` are the options to be passed to the `SimplePeer` constructor.

### `signalClient.on('discover', function (remoteID, discoveryData) {})`
Fired when the client has discovered a remote peer with the room password, or that peer has restarted discovery.

`remoteID` is the remote ID of the new peer.

`discoveryData` is any additional data that has been passed by the remote peer.

### `signalClient.on('request', function (request) {})`
Fired on receiving a request to connect from another client.

#### `request.initiator`
The id of the remote client's socket.

#### `request.metadata`
Any additional metadata passed by the requesting client.

#### `{ peer, metadata } = await request.accept([metadata], [peerOptions])`
Accept the request to connect. *Not calling this method will ignore the request.*  Returns a Promise.

`metadata` is any serializable object to be passed along with the answer.

`peerOptions` are the options to be passed to the `SimplePeer` constructor.

Promise will reject if the other side calls `reject()`.

#### `request.reject([metadata])`
Rejects the request to connect. *Not calling this method will ignore the request.*

`metadata` is any serializable object to be passed along with the rejection.

### `signalClient.peers()`
List all currently connecting/connected peers. Returns an array of `SimplePeer` objects.

## FAQ
### How do I setup the local Ethereum Node?
1. Download Grid: https://grid.ethereum.org/#downloads
2. Install and launch Grid.
3. Go to `Geth > Settings` and enable `Use custom flags`.
4. Add these flags to enable Websockets and Whisper:
```
--ws --wsorigins=* --port 30303 --nousb --shh
```
5. Start Geth and wait for the node to sync.
6. Done! You can now use this library to connect to everyone else on the Ethereum Whisper network!
