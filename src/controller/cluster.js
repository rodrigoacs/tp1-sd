import fs from 'node:fs'
import { proto, connect, call } from '../common.js'

const TICK = 500
const PEER_TIMEOUT = 1500
const STARTUP = 2000

export class Cluster {
  constructor(id, peers, initialState, log) {
    this.id = id
    this.log = log
    this.file = `data/controller-${id}.json`
    const saved = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file)) : {}
    this.term = saved.term ?? 0
    this.version = saved.version ?? 0
    this.state = saved.state ?? initialState
    this.leaderId = 0
    this.startedAt = Date.now()
    this.peers = peers.map((peer) => ({ ...peer, client: connect(proto.Peer, peer.address), lastSeen: 0, info: null }))
    this.majority = Math.floor((peers.length + 1) / 2) + 1
    this.onLeader = () => {}
    setInterval(() => this.tick(), TICK)
  }

  get isLeader() {
    return this.leaderId === this.id
  }

  info(state = '') {
    return { id: this.id, term: this.term, leaderId: this.leaderId, version: this.version, state }
  }

  save() {
    fs.mkdirSync('data', { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify({ term: this.term, version: this.version, state: this.state }))
  }

  alive() {
    return this.peers.filter((peer) => Date.now() - peer.lastSeen < PEER_TIMEOUT)
  }

  tick() {
    const message = this.info(this.isLeader ? JSON.stringify(this.state) : '')
    for (const peer of this.peers) {
      call(peer.client, 'Heartbeat', message, 400).then((reply) => this.receive(reply), () => {})
    }
    this.elect()
  }

  receive(message) {
    const peer = this.peers.find((item) => item.id === message.id)
    if (peer) {
      peer.lastSeen = Date.now()
      peer.info = message
    }
    const lowerLeader = message.leaderId && (!this.leaderId || message.leaderId < this.leaderId)
    if (message.term > this.term || (message.term === this.term && lowerLeader)) {
      this.term = message.term
      this.setLeader(message.leaderId)
    }
    if (message.state && message.id === this.leaderId && message.version >= this.version) {
      this.state = JSON.parse(message.state)
      this.version = message.version
      this.save()
    }
    return this.info()
  }

  setLeader(id) {
    if (id === this.leaderId) return
    this.leaderId = id
    this.log(id ? `líder: controlador ${id} (termo ${this.term})` : 'sem líder')
    if (this.isLeader) this.onLeader()
  }

  elect() {
    const alive = this.alive()
    const quorum = alive.length + 1 >= this.majority
    if (this.isLeader) {
      if (!quorum) this.setLeader(0)
      return
    }
    if (alive.some((peer) => peer.id === this.leaderId)) return
    this.setLeader(0)
    if (!quorum || Date.now() - this.startedAt < STARTUP) return
    const nodes = [this.info(), ...alive.map((peer) => peer.info)]
    const best = nodes.sort((a, b) => b.version - a.version || a.id - b.id)[0]
    if (best.id === this.id) {
      this.term = Math.max(...nodes.map((node) => node.term)) + 1
      this.setLeader(this.id)
    }
  }

  async commit(change) {
    const next = structuredClone(this.state)
    change(next)
    const message = { ...this.info(JSON.stringify(next)), version: this.version + 1 }
    const acks = await Promise.all(
      this.alive().map((peer) => call(peer.client, 'Heartbeat', message, 600).then((reply) => reply.version >= message.version, () => false)),
    )
    if (acks.filter(Boolean).length + 1 < this.majority) throw new Error('sem quorum para replicar')
    this.state = next
    this.version = message.version
    this.save()
  }
}
