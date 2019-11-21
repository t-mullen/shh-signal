
const cuid = require('cuid')
const inherits = require('inherits')
const EventEmitter = require('nanobus')
const SimplePeer = require('simple-peer')

const TTL = 5
const POW_TARGET = 2.01
const POW_TIME = 20

const TOPIC_DISCOVER = '0x87139212'
const TOPIC_OFFER = '0x09124928'
const TOPIC_SIGNAL = '0x92489214'
const TOPIC_REJECT = '0x89214711'

const ERR_CONNECTION_TIMEOUT = 'ERR_CONNECTION_TIMEOUT'
const ERR_PREMATURE_CLOSE = 'ERR_PREMATURE_CLOSE'

inherits(ShhSignalClient, EventEmitter)

function ShhSignalClient (web3, options = {}) {
  if (!(this instanceof ShhSignalClient)) return new ShhSignalClient(web3, options)

  EventEmitter.call(this)

  const { connectionTimeout = 1000 * 1000, roomPassword = '' } = options

  this.web3 = web3
  this._connectionTimeout = connectionTimeout

  this._peers = {}
  this._sessionQueues = {}
  this._timers = new Map()

  async function init () {
    this._roomKeyID = await web3.shh.generateSymKeyFromPassword(roomPassword)
    this._mySigID = await web3.shh.newKeyPair()
    this._keyPairID = await web3.shh.newKeyPair()

    this._myPublicKey = await web3.shh.getPublicKey(this._keyPairID)
    this._mySig = await web3.shh.getPublicKey(this._mySigID)

    this.web3.shh.subscribe('messages', { symKeyID: this._roomKeyID, topics: [TOPIC_DISCOVER] }, this._handle(this._onDiscover.bind(this)))
    this.web3.shh.subscribe('messages', { privateKeyID: this._keyPairID, topics: [TOPIC_OFFER] }, this._handle(this._onOffer.bind(this)))
    this.web3.shh.subscribe('messages', { privateKeyID: this._keyPairID, topics: [TOPIC_SIGNAL] }, this._handle(this._onSignal.bind(this)))
    this.web3.shh.subscribe('messages', { privateKeyID: this._keyPairID, topics: [TOPIC_REJECT] }, this._handle(this._onReject.bind(this)))

    this.id = { pubKey: this._myPublicKey, sig: this._mySig }
    this.emit('ready')
  }
  init.call(this)
}

ShhSignalClient.prototype._handle = function (callback) {
  // returns a wrapper that only passes messages are valid JSON, that are signed, and not our own
  return (err, whisper) => {
    if (err) return console.error(err)
    if (!whisper.sig) return // ignore unsigned messages
    if (whisper.sig === this._mySig) return // ignore own messages
    const rxPayload = deserialize(whisper.payload)
    if (!rxPayload) return // ignore invalid JSON, empty messages
    whisper.scopedSessionId = whisper.sig + rxPayload.sessionId // scope sessionId to signature
    whisper.rawSessionId = rxPayload.sessionId
    callback(whisper, rxPayload)
  }
}

ShhSignalClient.prototype._onDiscover = function (whisper, { pubKey, discoveryData }) {
  if (!pubKey) return
  this.emit('discover', { pubKey, sig: whisper.sig }, discoveryData)
}

ShhSignalClient.prototype._onOffer = function (whisper, { pubKey, metadata, signal }) {
  if (!pubKey || !signal) return
  this._sessionQueues[whisper.scopedSessionId] = [signal]

  const request = { metadata }
  request.initiator = { pubKey, sig: whisper.sig }
  request.accept = this._accept.bind(this, request, whisper)
  request.reject = this._reject.bind(this, request, whisper)

  this.emit('request', request)
}

ShhSignalClient.prototype._accept = function (request, whisper, metadata = {}, peerOptions = {}) {
  peerOptions.initiator = false
  const peer = this._peers[whisper.scopedSessionId] = new SimplePeer(peerOptions)

  peer.on('signal', (signal) => {
    const txPayload = serialize({
      // no public key required here, they already know our claimed identity
      signal,
      metadata,
      sessionId: whisper.rawSessionId // send the raw sessionId, it will be scoped to our signature
    })
    this.web3.shh.post({
      pubKey: request.initiator.pubKey, // addressed to their claimed identity
      sig: this._mySigID, // sign it
      payload: txPayload,
      topic: TOPIC_SIGNAL,
      ttl: TTL,
      powTarget: POW_TARGET,
      powTime: POW_TIME
    })
  })

  peer.once('close', () => {
    this._closePeer(whisper.scopedSessionId)
  })

  // clear signaling queue
  this._sessionQueues[whisper.scopedSessionId].forEach(signal => {
    console.log(signal)
    peer.signal(signal)
  })
  delete this._sessionQueues[whisper.scopedSessionId]

  return new Promise((resolve, reject) => {
    this._onSafeConnect(peer, () => {
      this._clearTimer(whisper.scopedSessionId)

      resolve({ peer, metadata: request.metadata })
    })

    peer.once('close', () => {
      reject({ metadata: { code: ERR_PREMATURE_CLOSE } })
    })

    this._startTimer(whisper.scopedSessionId, metadata => {
      reject({ metadata })
      this._closePeer(whisper.scopedSessionId)
    })
  })
}

ShhSignalClient.prototype._reject = function (request, whisper, metadata = {}) {
  // clear signaling queue
  delete this._sessionQueues[whisper.scopedSessionId]
  this._clearTimer(whisper.scopedSessionId)

  const txPayload = serialize({
    // no public key required here, they already know our claimed identity
    metadata,
    sessionId: whisper.rawSessionId // raw sessionId will be scoped to our signature
  })
  this.web3.shh.post({
    pubKey: request.initiator.pubKey, // addressed to their claimed identity
    sig: this._mySigID, // sign it
    payload: txPayload,
    topic: TOPIC_REJECT,
    ttl: TTL,
    powTarget: POW_TARGET,
    powTime: POW_TIME
  })
}

ShhSignalClient.prototype._onReject = function (whisper, { metadata }) {
  const peer = this._peers[whisper.scopedSessionId]
  if (peer) peer.reject(metadata)
}

ShhSignalClient.prototype._onSignal = function (whisper, { signal, metadata }) {
  const peer = this._peers[whisper.scopedSessionId]
  if (peer) {
    console.log(signal)
    peer.signal(signal)
    if (metadata !== undefined && peer.resolveMetadata) peer.resolveMetadata(metadata)
  } else {
    this._sessionQueues[whisper.scopedSessionId] = this._sessionQueues[whisper.scopedSessionId] || []
    this._sessionQueues[whisper.scopedSessionId].push(signal)
  }
}

ShhSignalClient.prototype.connect = function (target, metadata = {}, peerOptions = {}) {
  if (!this.id) throw new Error('Must complete discovery first.')

  peerOptions.initiator = true

  const rawSessionId = cuid() // This is scoped to their signature, so only needs to be locally unique
  const scopedSessionId = target.sig + rawSessionId
  var firstOffer = true
  const peer = this._peers[scopedSessionId] = new SimplePeer(peerOptions)

  peer.once('close', () => {
    this._closePeer(scopedSessionId)
  })

  peer.on('signal', (signal) => {
    const topic = signal.sdp && firstOffer ? TOPIC_OFFER : TOPIC_SIGNAL
    if (signal.sdp) firstOffer = false

    const txPayload = serialize({
      pubKey: this._myPublicKey,
      signal,
      metadata,
      sessionId: rawSessionId // remote peer will scope this to our signature
    })
    this.web3.shh.post({
      pubKey: target.pubKey, // addressed to their claimed identity
      sig: this._mySigID, // sign it
      payload: txPayload,
      topic,
      ttl: TTL,
      powTarget: POW_TARGET,
      powTime: POW_TIME
    })
  })

  return new Promise((resolve, reject) => {
    peer.resolveMetadata = (metadata) => {
      peer.resolveMetadata = null
      this._onSafeConnect(peer, () => {
        this._clearTimer(scopedSessionId)

        resolve({ peer, metadata })
      })
    }

    peer.reject = (metadata) => {
      reject({ metadata }) // eslint-disable-line
      this._closePeer(scopedSessionId)
    }

    peer.once('close', () => {
      reject({ metadata: { code: ERR_PREMATURE_CLOSE } })
    })

    this._startTimer(scopedSessionId, metadata => peer.reject(metadata))
  })
}

ShhSignalClient.prototype._onSafeConnect = function (peer, callback) {
  // simple-signal caches stream and track events so they always come AFTER connect
  const cachedEvents = []
  function streamHandler (stream) {
    cachedEvents.push({ name: 'stream', args: [stream] })
  }
  function trackHandler (track, stream) {
    cachedEvents.push({ name: 'track', args: [track, stream] })
  }
  peer.on('stream', streamHandler)
  peer.on('track', trackHandler)
  peer.once('connect', () => {
    setTimeout(() => {
      peer.emit('connect') // expose missed 'connect' event to application
      setTimeout(() => {
        cachedEvents.forEach(({ name, args }) => { // replay any missed stream/track events
          peer.emit(name, ...args)
        })
      }, 0)
    }, 0)
    peer.removeListener('stream', streamHandler)
    peer.removeListener('track', trackHandler)
    callback(peer)
  })
}

ShhSignalClient.prototype._closePeer = function (sessionId) {
  const peer = this._peers[sessionId]
  this._clearTimer(sessionId)
  delete this._peers[sessionId]
  if (peer) peer.destroy()
}

ShhSignalClient.prototype._startTimer = function (sessionId, cb) {
  if (this._connectionTimeout !== -1) {
    const timer = setTimeout(() => {
      this._clearTimer(sessionId)
      cb({ code: ERR_CONNECTION_TIMEOUT })
    }, this._connectionTimeout)
    this._timers.set(sessionId, timer)
  }
}

ShhSignalClient.prototype._clearTimer = function (sessionId) {
  if (this._timers.has(sessionId)) {
    clearTimeout(this._timers.get(sessionId))
    this._timers.delete(sessionId)
  }
}

ShhSignalClient.prototype.discover = function (discoveryData = {}) {
  if (!this.id) {
    this.once('ready', () => {
      this.discover(discoveryData)
    })
    return
  }
  const txPayload = serialize({
    pubKey: this._myPublicKey,
    discoveryData
  })
  this.web3.shh.post({
    symKeyID: this._roomKeyID,
    sig: this._mySigID, // sign it
    payload: txPayload,
    topic: TOPIC_DISCOVER,
    ttl: TTL,
    powTarget: POW_TARGET,
    powTime: POW_TIME
  })
}

ShhSignalClient.prototype.peers = function () {
  return Object.values(this._peers)
}

ShhSignalClient.prototype.destroy = function () {
  this.peers().forEach(peer => peer.destroy())

  this.id = null
  this.web3 = null
  this._peers = null
  this._sessionQueues = null
}

function fromAscii (str, padding) {
  var hex = '0x'
  for (var i = 0; i < str.length; i++) {
    var code = str.charCodeAt(i)
    var n = code.toString(16)
    hex += n.length < 2 ? '0' + n : n
  }
  return hex + '0'.repeat(padding * 2 - hex.length + 2)
}
function serialize (obj) {
  return fromAscii(JSON.stringify(obj))
}

function toAscii (hex) {
  var str = ''
  var i = 0
  var l = hex.length
  if (hex.substring(0, 2) === '0x') {
    i = 2
  }
  for (; i < l; i += 2) {
    var code = parseInt(hex.substr(i, 2), 16)
    if (code === 0) continue // this is added
    str += String.fromCharCode(code)
  }
  return str
}
function deserialize (str) {
  try {
    return JSON.parse(toAscii(str))
  } catch (err) {
    console.warn('failed to parse JSON ' + toAscii(str))
    return null
  }
}

module.exports = ShhSignalClient
module.exports.SimplePeer = SimplePeer
module.exports.ERR_CONNECTION_TIMEOUT = ERR_CONNECTION_TIMEOUT
module.exports.ERR_PREMATURE_CLOSE = ERR_PREMATURE_CLOSE
