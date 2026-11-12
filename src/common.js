import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'

export const config = {
  mqttUrl: process.env.MQTT_URL,
  controllers: process.env.CONTROLLERS.split(',').map((item) => {
    const [id, address] = item.split('@')
    return { id: Number(id), address }
  }),
}

export const topics = {
  reader: 'factory/sensors/reader',
  scale: 'factory/sensors/scale',
  climate: 'factory/sensors/climate',
  conveyor: 'factory/actuators/conveyor',
  sealer: 'factory/actuators/sealer',
  rejector: 'factory/actuators/rejector',
}

export const CARD_GRAMS = 1.78
export const WRAPPER_GRAMS = 1.5

export const proto = grpc.loadPackageDefinition(
  protoLoader.loadSync('proto/factory.proto', { longs: Number, defaults: true }),
).factory

export { grpc }

export const connect = (Service, address) => new Service(address, grpc.credentials.createInsecure())

export const call = (client, method, request, timeout) =>
  new Promise((resolve, reject) => {
    client[method](request, { deadline: Date.now() + timeout }, (error, reply) => (error ? reject(error) : resolve(reply)))
  })

export const logger = (name) => (message) => console.log(`[${new Date().toLocaleTimeString('pt-BR')}] [${name}] ${message}`)
