import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { config, proto, connect, call } from './common.js'

const nodes = config.controllers.map((controller) => ({ ...controller, client: connect(proto.Factory, controller.address) }))
const majority = Math.floor(nodes.length / 2) + 1
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let leaderId = 0
let screen = 'Aguardando os controladores...'
let lastReply = '-'

async function vote() {
  const replies = await Promise.all(nodes.map((node) => call(node.client, 'GetStatus', {}, 1000).catch(() => null)))
  const groups = new Map()
  for (const status of replies.filter(Boolean)) {
    const { nodeId, leaderId: _, ...data } = status
    const key = JSON.stringify(data)
    groups.set(key, [...(groups.get(key) ?? []), status])
  }
  const winner = [...groups.values()].find((group) => group.length >= majority)
  const suspects = winner ? replies.filter((status) => status && !winner.includes(status)).map((status) => status.nodeId) : []
  return { status: winner?.[0], voters: winner?.map((status) => status.nodeId) ?? [], suspects }
}

function render({ status, voters, suspects }) {
  const alert = suspects.length ? `  ALERTA: controlador ${suspects.join(', ')} divergente` : ''
  return [
    `Fábrica de Boosters | líder: ${status.leaderId || 'nenhum'} | versão ${status.version}`,
    `Confirmado pelos controladores ${voters.join(', ')}${alert}`,
    '',
    `Linha:    ${status.status}${status.reason ? ` (${status.reason})` : ''}`,
    `Lote:     ${status.batch || '-'}  ${status.approved}/${status.target} aprovados, ${status.rejected} rejeitados, ${status.pending} na balança`,
    `Booster:  comuns ${status.common}/10  incomuns ${status.uncommon}/3  rara ${status.rare}/1`,
    `Clima:    ${status.temperature} °C, ${status.humidity} %`,
    '',
    ...status.events,
  ].join('\n')
}

function draw() {
  process.stdout.write(`\x1b[H\x1b[2J${screen}\n\nÚltima resposta: ${lastReply}\nComandos: start <coleção> <quantidade> | pause | resume | sair\n`)
  rl.prompt(true)
}

async function refresh() {
  let result = await vote()
  if (!result.status) result = await sleep(200).then(vote)
  if (result.status) {
    leaderId = result.status.leaderId
    screen = render(result)
  } else {
    screen = 'Sem maioria entre os controladores'
  }
  draw()
}

async function command(method, fields = {}) {
  const request = { requestId: randomUUID(), ...fields }
  for (let attempt = 0; attempt < 20; attempt++) {
    const node = nodes.find((item) => item.id === leaderId) ?? nodes[attempt % nodes.length]
    try {
      const reply = await call(node.client, method, request, 2000)
      if (reply.ok || reply.leaderId === reply.nodeId) return reply
      leaderId = reply.leaderId
    } catch {
      leaderId = 0
    }
    await sleep(500)
  }
  return { ok: false, message: 'nenhum controlador respondeu' }
}

const methods = {
  start: ([setCode, target]) => ['StartBatch', { setCode, target: Number(target) }],
  pause: () => ['PauseLine'],
  resume: () => ['ResumeLine'],
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' })

rl.on('line', async (line) => {
  const [name, ...args] = line.trim().split(/\s+/)
  if (name === 'sair') process.exit(0)
  if (!methods[name]) return draw()
  lastReply = 'enviando...'
  draw()
  const reply = await command(...methods[name](args))
  lastReply = `${reply.ok ? 'ok' : 'erro'}: ${reply.message}${reply.nodeId ? ` (controlador ${reply.nodeId})` : ''}`
  draw()
})

setInterval(refresh, 1000)
draw()
