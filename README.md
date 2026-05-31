# SGI Renovar | Scheduler Automático

Este serviço roda em loop e cria alertas automáticos no Supabase.

## Funções

- Documentos SST vencidos ou próximos do vencimento;
- Eventos eSocial com erro, recusados ou rejeitados;
- ASO com necessidade de revisão;
- CAT sem confirmação final de envio;
- Alimenta a tabela `alertas_sgi`.

## Render

Crie outro Background Worker no Render ou use este pacote em serviço separado.

Build Command:
npm install

Start Command:
node scheduler.js

## Variáveis

SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SCHEDULER_INTERVAL_MS=60000
ALERTA_DOCUMENTOS_DIAS=60
ALERTA_ASO_DIAS=30
