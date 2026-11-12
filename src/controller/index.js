import mqtt from 'mqtt'
import { config, topics, proto, grpc, logger, CARD_GRAMS, WRAPPER_GRAMS } from '../common.js'
import { Cluster } from './cluster.js'

const COMPOSITION = { common: 10, uncommon: 3, rare: 1 }
const PACK_GRAMS = 14 * CARD_GRAMS + WRAPPER_GRAMS
const TOLERANCE = 1
const MAX_HUMIDITY = 65
const HUMIDITY = 'umidade alta'

const id = Number(process.env.NODE_ID)
const me = config.controllers.find((controller) => controller.id === id)
const log = logger(`controlador ${id}`)

const initialState = {
  status: 'parada',
  reason: '',
  batch: '',
  batches: 0,
  target: 0,
  approved: 0,
  rejected: 0,
  pack: { common: 0, uncommon: 0, rare: 0 },
  packs: 0,
  pending: [],
  temperature: 0,
  humidity: 0,
  events: [],
  requests: {},
}

const cluster = new Cluster(id, config.controllers.filter((controller) => controller !== me), initialState, log)
const broker = mqtt.connect(config.mqttUrl)

let queue = Promise.resolve()
const run = (task) => {
  const result = queue.then(task)
  queue = result.catch(() => {})
  return result
}

const addEvent = (state, text) => {
  state.events = [`${new Date().toLocaleTimeString('pt-BR')} ${text}`, ...state.events].slice(0, 8)
}

const publishConveyor = () => broker.publish(topics.conveyor, JSON.stringify({ on: cluster.state.status === 'produzindo' }))

async function update(change) {
  const before = cluster.state.status
  await cluster.commit(change)
  if (cluster.state.status !== before) publishConveyor()
}

const sensors = {
  async [topics.reader]({ rarity }) {
    const slot = rarity === 'mythic' ? 'rare' : rarity
    const { status, pack } = cluster.state
    if (status !== 'produzindo' || pack[slot] >= COMPOSITION[slot]) return
    let sealed = null
    await update((state) => {
      state.pack[slot] += 1
      if (Object.keys(COMPOSITION).some((key) => state.pack[key] < COMPOSITION[key])) return
      state.packs += 1
      sealed = `${state.batch}-${state.packs}`
      state.pending.push(sealed)
      state.pack = { common: 0, uncommon: 0, rare: 0 }
    })
    if (sealed) broker.publish(topics.sealer, JSON.stringify({ packId: sealed, cards: 14 }))
  },

  async [topics.scale]({ packId, grams }) {
    if (!cluster.state.pending.includes(packId)) return
    const ok = Math.abs(grams - PACK_GRAMS) <= TOLERANCE
    await update((state) => {
      state.pending = state.pending.filter((pending) => pending !== packId)
      if (ok) state.approved += 1
      else state.rejected += 1
      addEvent(state, `booster ${packId} ${ok ? 'aprovado' : 'rejeitado'} (${grams} g)`)
      if (state.approved >= state.target) {
        state.status = 'parada'
        state.reason = 'lote concluído'
        addEvent(state, `lote ${state.batch} concluído`)
      }
    })
    broker.publish(topics.rejector, JSON.stringify({ packId, ok }))
  },

  async [topics.climate]({ temperature, humidity }) {
    await update((state) => {
      state.temperature = temperature
      state.humidity = humidity
      if (state.status === 'produzindo' && humidity > MAX_HUMIDITY) {
        state.status = 'pausada'
        state.reason = HUMIDITY
        addEvent(state, `linha pausada por umidade alta (${humidity} %)`)
      } else if (state.reason === HUMIDITY && humidity < MAX_HUMIDITY - 5) {
        state.status = 'produzindo'
        state.reason = ''
        addEvent(state, 'umidade normalizada, linha retomada')
      }
    })
  },
}

broker.subscribe(Object.keys(sensors))
broker.on('message', (topic, payload) => {
  if (!cluster.isLeader) return
  run(() => sensors[topic](JSON.parse(payload))).catch((error) => log(error.message))
})

cluster.onLeader = () => run(publishConveyor)

const commands = {
  start({ setCode, target }, state) {
    if (state.status !== 'parada') return { error: `o lote ${state.batch} ainda está em andamento` }
    if (!setCode || !(target > 0)) return { error: 'use: start <coleção> <quantidade>' }
    const batch = `${setCode.toUpperCase()}-${state.batches + 1}`
    return {
      message: `lote ${batch} iniciado com ${target} boosters`,
      change: (next) => Object.assign(next, {
        status: 'produzindo', reason: '', batch, batches: next.batches + 1, target, approved: 0, rejected: 0, packs: 0, pending: [],
        pack: { common: 0, uncommon: 0, rare: 0 },
      }),
    }
  },
  pause(_, state) {
    if (state.status !== 'produzindo') return { error: 'a linha não está produzindo' }
    return { message: 'linha pausada pelo operador', change: (next) => Object.assign(next, { status: 'pausada', reason: 'operador' }) }
  },
  resume(_, state) {
    if (state.reason !== 'operador') return { error: 'a linha não está pausada pelo operador' }
    return { message: 'linha retomada pelo operador', change: (next) => Object.assign(next, { status: 'produzindo', reason: '' }) }
  },
}

const execute = (name) => (call, callback) => {
  const reply = (result) => callback(null, { ...result, nodeId: id, leaderId: cluster.leaderId })
  run(async () => {
    if (!cluster.isLeader) return { ok: false, message: 'não sou o líder' }
    const { requestId } = call.request
    const previous = cluster.state.requests[requestId]
    if (previous) return { ...previous, message: `${previous.message} (repetida)` }
    const { error, message, change } = commands[name](call.request, cluster.state)
    if (error) return { ok: false, message: error }
    const result = { ok: true, message }
    await update((state) => {
      change(state)
      addEvent(state, message)
      state.requests[requestId] = result
      const ids = Object.keys(state.requests)
      if (ids.length > 100) delete state.requests[ids[0]]
    })
    return result
  }).then(reply, (error) => reply({ ok: false, message: error.message }))
}

const server = new grpc.Server()

server.addService(proto.Factory.service, {
  GetStatus: (_, callback) => {
    const { pack, pending, ...state } = cluster.state
    const status = { ...state, ...pack, pending: pending.length, nodeId: id, leaderId: cluster.leaderId, version: cluster.version }
    if (process.env.FAULT === 'lie') status.approved += 3
    callback(null, status)
  },
  StartBatch: execute('start'),
  PauseLine: execute('pause'),
  ResumeLine: execute('resume'),
})

server.addService(proto.Peer.service, {
  Heartbeat: (call, callback) => callback(null, cluster.receive(call.request)),
})

server.bindAsync(`0.0.0.0:${me.address.split(':')[1]}`, grpc.ServerCredentials.createInsecure(), () => log('iniciado'))
