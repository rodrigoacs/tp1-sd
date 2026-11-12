# Booster Factory

Trabalho prático de Sistemas Distribuídos: fábrica de boosters de Magic com MQTT, 3 controladores replicados e clientes gRPC. Relatório em `docs/relatorio.md`.

## Como rodar

```bash
cp .env.example .env
npm install
npm run broker
```

Depois, um terminal para cada:

```bash
npm run controller:1
npm run controller:2
npm run controller:3
npm run plant
npm run client
```

## Cliente

- `start DSK 10`: inicia um lote de 10 boosters
- `pause` / `resume`
- `sair`

## Testes de falha

- Derrubar o líder: Ctrl+C no terminal dele. Outro assume e o cliente continua funcionando.
- Controlador com valores errados: `FAULT=lie npm run controller:3`. O cliente mostra o 3 como divergente.
- No terminal da planta: `umidade` (a linha pausa sozinha) ou `defeito` (o próximo booster é rejeitado).
