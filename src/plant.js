import mqtt from 'mqtt'
import readline from 'node:readline'
import { config, topics, logger, CARD_GRAMS, WRAPPER_GRAMS } from './common.js'

const RARITIES = [['common', 0.62], ['uncommon', 0.26], ['rare', 0.1], ['mythic', 0.02]]

const log = logger('planta')
const broker = mqtt.connect(config.mqttUrl)
const plant = { running: false, humidity: 50, temperature: 24, humidUntil: 0, defect: false }

const publish = (topic, data) => broker.publish(topic, JSON.stringify(data))
const noise = (size) => (Math.random() * 2 - 1) * size
const round = (value) => Math.round(value * 10) / 10

function drawRarity() {
  let roll = Math.random()
  return RARITIES.find(([, weight]) => (roll -= weight) <= 0)?.[0] ?? 'common'
}

const actuators = {
  [topics.conveyor]({ on }) {
    if (on !== plant.running) log(on ? 'esteira ligada' : 'esteira desligada')
    plant.running = on
  },
  [topics.sealer]({ packId, cards }) {
    if (plant.defect || Math.random() < 0.05) {
      cards += Math.random() < 0.5 ? -1 : 1
      plant.defect = false
      log(`booster ${packId} saiu com ${cards} cartas`)
    }
    const grams = Math.round((cards * CARD_GRAMS + WRAPPER_GRAMS + noise(0.15)) * 100) / 100
    setTimeout(() => publish(topics.scale, { packId, grams }), 400)
  },
  [topics.rejector]({ packId, ok }) {
    log(`booster ${packId} ${ok ? 'enviado para expedição' : 'descartado'}`)
  },
}

broker.subscribe(Object.keys(actuators))
broker.on('message', (topic, payload) => actuators[topic](JSON.parse(payload)))

setInterval(() => {
  if (plant.running) publish(topics.reader, { rarity: drawRarity() })
}, 300)

setInterval(() => {
  const target = Date.now() < plant.humidUntil ? 78 : 50
  plant.humidity += (target - plant.humidity) * 0.35 + noise(1)
  plant.temperature += (24 - plant.temperature) * 0.2 + noise(0.3)
  publish(topics.climate, { temperature: round(plant.temperature), humidity: round(plant.humidity) })
}, 2000)

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === 'umidade') plant.humidUntil = Date.now() + 20000
  if (line.trim() === 'defeito') plant.defect = true
  log(`simulando: ${line.trim()}`)
})

log('digite "umidade" ou "defeito" para simular problemas')
