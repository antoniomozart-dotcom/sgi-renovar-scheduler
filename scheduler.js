import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const INTERVALO = Number(process.env.SCHEDULER_INTERVAL_MS || 60000);
const DIAS_DOCUMENTOS = Number(process.env.ALERTA_DOCUMENTOS_DIAS || 60);
const DIAS_ASO = Number(process.env.ALERTA_ASO_DIAS || 30);

let executando = false;

function esperar(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hojeISO(){
  return new Date().toISOString().slice(0,10);
}

function addDias(dias){
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0,10);
}

function diffDias(data){
  if(!data) return null;
  const hoje = new Date();
  hoje.setHours(0,0,0,0);
  const alvo = new Date(data + "T00:00:00");
  return Math.ceil((alvo - hoje) / (1000 * 60 * 60 * 24));
}

async function alertaExiste(chave){
  const { data, error } = await supabase
    .from("alertas_sgi")
    .select("id")
    .eq("chave_origem", chave)
    .neq("status", "resolvido")
    .limit(1);

  if(error){
    console.error("Erro ao verificar alerta:", error.message);
    return true;
  }

  return data && data.length > 0;
}

async function criarAlerta(payload){
  if(!payload.chave_origem) return;

  const existe = await alertaExiste(payload.chave_origem);

  if(existe) return;

  const { error } = await supabase
    .from("alertas_sgi")
    .insert([{
      ...payload,
      status: "pendente",
      gerado_automaticamente: true
    }]);

  if(error){
    console.error("Erro ao criar alerta:", error.message);
  }else{
    console.log("Alerta criado:", payload.titulo);
  }
}

async function gerarAlertasDocumentos(){
  const dataLimite = addDias(DIAS_DOCUMENTOS);

  const { data, error } = await supabase
    .from("documentos_sst")
    .select("id,empresa_id,tipo_documento,nome_documento,data_validade,responsavel")
    .not("data_validade", "is", null)
    .lte("data_validade", dataLimite);

  if(error){
    console.error("Erro documentos:", error.message);
    return;
  }

  for(const doc of data || []){
    const dias = diffDias(doc.data_validade);

    const vencido = dias < 0;

    await criarAlerta({
      empresa_id: doc.empresa_id,
      origem: "Documentos SST",
      prioridade: vencido ? "critica" : dias <= 30 ? "alta" : "media",
      titulo: `${doc.tipo_documento || "Documento"} ${vencido ? "vencido" : "a vencer"}`,
      descricao: `${doc.nome_documento || "Documento SST"} ${vencido ? "venceu" : "vence"} em ${doc.data_validade}. Dias: ${dias}.`,
      data_vencimento: doc.data_validade,
      responsavel: doc.responsavel || "SST / Compliance",
      chave_origem: `scheduler-documento-${doc.id}-${doc.data_validade}`
    });
  }
}

async function gerarAlertasEsocial(){
  const { data, error } = await supabase
    .from("eventos_esocial")
    .select("id,empresa_id,evento_codigo,nome_trabalhador,status,erro_mensagem,created_at")
    .in("status", ["erro", "recusado", "rejeitado"]);

  if(error){
    console.error("Erro eSocial:", error.message);
    return;
  }

  for(const ev of data || []){
    await criarAlerta({
      empresa_id: ev.empresa_id,
      origem: "eSocial",
      prioridade: "alta",
      titulo: `Evento ${ev.evento_codigo} com ${ev.status}`,
      descricao: `Trabalhador: ${ev.nome_trabalhador || "-"}. Erro: ${ev.erro_mensagem || "Verificar Central Operacional eSocial."}`,
      data_vencimento: null,
      responsavel: "Operação eSocial",
      chave_origem: `scheduler-esocial-${ev.id}-${ev.status}`
    });
  }
}

async function gerarAlertasASO(){
  const dataLimite = addDias(DIAS_ASO);

  const { data, error } = await supabase
    .from("s2220_aso")
    .select("id,empresa_id,nome_trabalhador,cpf_trabalhador,data_aso,tipo_exame,resultado_aso,status_esocial")
    .lte("data_aso", dataLimite);

  if(error){
    console.error("Erro ASO:", error.message);
    return;
  }

  // Regra simples: ASO muito antigo sem novo controle deve ser revisado.
  // Depois podemos substituir por validade calculada por risco/cargo.
  const hoje = new Date();

  for(const aso of data || []){
    if(!aso.data_aso) continue;

    const dataAso = new Date(aso.data_aso + "T00:00:00");
    const diasPassados = Math.floor((hoje - dataAso) / (1000 * 60 * 60 * 24));

    if(diasPassados >= 335){
      await criarAlerta({
        empresa_id: aso.empresa_id,
        origem: "ASO",
        prioridade: diasPassados >= 365 ? "alta" : "media",
        titulo: `ASO ${diasPassados >= 365 ? "vencido" : "próximo do vencimento"}`,
        descricao: `${aso.nome_trabalhador || "Trabalhador"} possui ASO de ${aso.data_aso}. Tipo: ${aso.tipo_exame || "-"}.`,
        data_vencimento: aso.data_aso,
        responsavel: "Saúde Ocupacional",
        chave_origem: `scheduler-aso-${aso.id}-${aso.data_aso}`
      });
    }
  }
}

async function gerarAlertasCAT(){
  const { data, error } = await supabase
    .from("cat_comunicacoes")
    .select("id,empresa_id,nome_trabalhador,data_acidente,status,status_esocial")
    .neq("status", "cancelado");

  if(error){
    console.error("Erro CAT:", error.message);
    return;
  }

  for(const cat of data || []){
    if(cat.status_esocial !== "enviado" && cat.status_esocial !== "processado"){
      await criarAlerta({
        empresa_id: cat.empresa_id,
        origem: "CAT",
        prioridade: "alta",
        titulo: "CAT sem confirmação de envio eSocial",
        descricao: `${cat.nome_trabalhador || "Trabalhador"} possui CAT registrada em ${cat.data_acidente || "-"} sem confirmação final no eSocial.`,
        data_vencimento: cat.data_acidente || null,
        responsavel: "SST / eSocial",
        chave_origem: `scheduler-cat-${cat.id}-${cat.status_esocial || "sem_status"}`
      });
    }
  }
}

async function ciclo(){
  if(executando) return;

  executando = true;

  console.log(`[${new Date().toLocaleString("pt-BR")}] Scheduler iniciado.`);

  try{
    await gerarAlertasDocumentos();
    await gerarAlertasEsocial();
    await gerarAlertasASO();
    await gerarAlertasCAT();
  }catch(err){
    console.error("Erro no ciclo:", err);
  }finally{
    executando = false;
    console.log(`[${new Date().toLocaleString("pt-BR")}] Scheduler finalizou o ciclo.`);
  }
}

async function main(){
  console.log("SGI Renovar Scheduler Automático iniciado.");
  console.log(`Intervalo: ${INTERVALO}ms`);

  await ciclo();

  while(true){
    await esperar(INTERVALO);
    await ciclo();
  }
}

main().catch(err => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
