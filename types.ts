export interface OSCampo {
  id?: number;
  numero: number | null;
  numero_fict?: number | null; // legado F-77/F-78 (sequência global antiga)
  fict_ref?: string | null;    // numeração POR EQUIPE: L01, L02… / M01, M02…
  emergencial: boolean;
  tipo?: string | null; // Emergencial | Corretiva | Preventiva (spec Renan 06/07)
  unidade: string;
  local?: string | null; // onde DENTRO da unidade: Cozinha, Sala 12, Consultório 03 (v81)
  contrato?: string | null; // 'Educação' | 'Saúde' — quem atende os dois marca aqui (v86)
  fiscal: string;
  classificacao: string;
  entrada: string | null;
  conclusao: string | null;
  executor: string;
  status: string;
  medicao: string;
  area?: string | null;
  solicitado?: string;
  servico: string;
  materiais: string;
  memoria_calculo: string;
  foto_urls: string[];
  criado_em?: string;
  assinado?: boolean;
  excluida?: boolean; // marca de exclusão — número preservado, log no banco
  geo?: string | null; // "lat,lng ±Xm" capturado ao salvar (prova de presença)
  prioridade?: number | null;     // 1..3 — definida pela gestão (RV000)
  par_sugerido?: string | null;   // matchmaking fictícia↔oficial (n8n)
  oficializada_em?: string | null;
}

// referência única da O.S. em TODA tela/planilha: nº oficial > ref da
// equipe (L01/M01) > F-nn legado > sem número
export const refDaOS = (o: Pick<OSCampo, 'numero' | 'fict_ref' | 'numero_fict'>): string =>
  o.numero != null ? String(o.numero)
    : (o.fict_ref || (o.numero_fict ? `F-${o.numero_fict}` : 'S/Nº'));

// régua única de BUSCA (v70): minúsculas, sem acento (jose acha JOSÉ,
// marcal acha MARÇAL) e letra dobrada colapsada (fanny acha Fany).
// Dígitos NÃO são colapsados — número é tratado à parte pelas telas.
export const buscaNorm = (s: string): string =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z])\1+/g, '$1');

// v120 — CHAVE DA ESCOLA para comparar nomes escritos de jeitos diferentes
// (a auditoria achou 122 grafias para 67 escolas): "E.M. Alberto Jorge",
// "Escola M. Alberto Jorge" e "ESCOLA MUNICIPAL ALBERTO JORGE" viram todas
// "alberto jorge". Tira acento, pontuação e as palavras de tipo de unidade.
const TIPO_UNIDADE = new Set(['escola', 'e', 'm', 'em', 'creche', 'municipal', 'ciep', 'de', 'da', 'do', 'dos', 'das']);
export const chaveEscola = (s: string): string =>
  buscaNorm(s || '').split(/[^a-z0-9]+/).filter(p => p && !TIPO_UNIDADE.has(p)).join(' ');
export const mesmaEscola = (a: string, b: string): boolean => {
  const ka = chaveEscola(a), kb = chaveEscola(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  // "imero" x "imero instituto ..." — um contém o outro (por palavra
  // inteira), com folga mínima para nome curto não casar com qualquer coisa
  const [menor, maior] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  return menor.length >= 5 && (` ${maior} `).includes(` ${menor} `);
};

export const TIPO_OPTIONS = ['Emergencial', 'Corretiva', 'Preventiva'];
// 'Avaliando' entrou pelo RV000 do engenheiro (funil: pendente →
// executando → assinatura → avaliando → concluída)
export const STATUS_OPTIONS = ['Pendente', 'Executando', 'Assinatura', 'Avaliando', 'Concluído', 'Material', 'Cancelada'];
// Educação: Wellington, Renato, Central · Saúde (03/09): Fernando (postos),
// Elisangela (SEMUSA), Cunha (hospital, UPA, CAPS, centros e o restante)
export const FISCAL_OPTIONS = ['Wellington', 'Renato', 'Central', 'Fernando', 'Elisangela', 'Cunha'];
export const CLASSIF_OPTIONS = ['Emergencial', 'Urgente', 'Normal'];
// REGRA (Renan 07/07): quem sai da operação SAI desta lista — o histórico
// mora só no banco (os_campo.executor guarda o nome como texto; a busca
// retroativa consulta os registros, não as opções). Miqueias saiu 07/07;
// Nicolas saiu 01/09 (as O.S. que ele executou seguem com o nome no banco).
export const EXECUTOR_OPTIONS = ['Gilson', 'Leandro', 'Carlos Alberto', 'Renato', 'Patrick', 'Edison', 'Emiliano', 'Matheus', 'Geilton', 'Marcio Junior', 'Queiroz', 'Neilson', 'Miqueias', 'Andre', 'Abraão', 'Caleb', 'Serviço Externo'];
// só a medição vigente por decisão do Renan (05/07) — valores antigos
// (MED 7 etc.) continuam visíveis ao editar O.S. que já os têm
// medições futuras abertas p/ despacho (Renan 21/07: O.S. recusada pelo
// fiscal migra p/ a medição seguinte na hora). Históricas aparecem no
// select por append quando a O.S. já as carrega.
export const MED_OPTIONS = ['', 'MED 8', 'MED 9', 'MED 10', 'MED 11', 'MED 12', 'MED 13'];
