// =====================================================================
// COMPARTILHAR O.S. NO GRUPO (v78, pedido do Renan 31/08)
//
// A dor: a emergencial é atendida, a foto sobe no app e no grupo do
// WhatsApp chega SOLTA — sem dizer qual escola, qual serviço, quem fez.
// Depois ninguém liga a foto à O.S. e a evidência se perde.
//
// A solução: ao salvar, o app monta a LEGENDA no padrão e compartilha
// texto + fotos de uma vez. É o mesmo fluxo do contrato de Saquarema
// (fotos antes/depois obrigatórias via grupo), só que com carimbo.
//
// Formatação: negrito do WhatsApp é *asterisco simples* (não **markdown**).
// O texto também cola bem em markdown comum e em e-mail.
// =====================================================================
import { OSCampo, refDaOS } from '../types';

const br = (iso?: string | null) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');

// o status concorda com "a O.S." (feminino) — é assim que o campo fala
const STATUS_LEGENDA: Record<string, string> = {
  'Concluído': 'Concluída',
  'Assinatura': 'Em assinatura',
  'Avaliando': 'Em avaliação',
  'Material': 'Aguardando material',
};

// LEGENDA PADRÃO (layout definido pelo Renan 31/08, vindo do contrato de
// Saquarema). A referência é a NOSSA (nº oficial da prefeitura ou a
// fictícia da equipe) — o OSE-nnnn é a numeração de lá, não a daqui.
// Linha sem valor não aparece: O.S. sem área/local sai enxuta em vez de
// sair com campo vazio.
//
//   *2190* — Concluída
//   Unidade: Creche M. Márcia Lustosa Machado
//   Local: Cozinha                (só quando houver o dado)
//   Tipo: HIDRÁULICA
//   Criticidade: Emergencial
//   Descrição: Manutenção na porta da sala de aula
// LOCAL e TIPO quase nunca vêm preenchidos (a `area` está vazia na maioria
// das O.S. e não existe campo de local). Como a descrição do fiscal quase
// sempre diz — "MANUTENÇÃO NA COZINHA", "troca de torneira do banheiro" —
// a legenda deduz do texto. Conservador: só assume quando a palavra
// aparece; na dúvida a linha não sai (melhor faltar que mentir).
const LOCAIS: [RegExp, string][] = [
  [/cozinha/i, 'Cozinha'], [/refeit[óo]rio/i, 'Refeitório'],
  [/banheiro|sanit[áa]rio|vaso|lavat[óo]rio|wc\b/i, 'Banheiro'],
  [/secretaria/i, 'Secretaria'], [/dire[çc][ãa]o/i, 'Direção'],
  [/sala de aula|sala \d+|salas de aula/i, 'Sala de aula'],
  [/p[áa]tio/i, 'Pátio'], [/quadra/i, 'Quadra'], [/corredor/i, 'Corredor'],
  [/bebedouro/i, 'Bebedouro'], [/almoxarifado/i, 'Almoxarifado'],
  [/dep[óo]sito|despensa/i, 'Depósito'], [/vesti[áa]rio/i, 'Vestiário'],
  [/recep[çc][ãa]o/i, 'Recepção'], [/telhado|calha/i, 'Telhado'],
  [/caixa d.?[áa]gua|cisterna|reservat[óo]rio/i, 'Caixa d\'água'],
  [/portão|portao|entrada principal/i, 'Portão'],
  [/ber[çc][áa]rio/i, 'Berçário'], [/biblioteca/i, 'Biblioteca'],
];
const TIPOS: [RegExp, string][] = [
  [/l[âa]mpada|tomada|interruptor|disjuntor|el[ée]tric|fia[çc][ãa]o|circuito|luminária|calha de ilumina|energia|curto/i, 'ELÉTRICA'],
  [/torneira|sif[ãa]o|descarga|vazamento|hidr[áa]ulic|registro|bomba d.?[áa]gua|rabicho|v[áa]lvula|cuba|ducha|entupi|vaso sanit|parafuso de vaso|tampa de vaso|assento sanit|sp?ud|espude|anel de cera|caixa acoplada|mict[óo]rio|chuveiro|filtro|bebedouro|tubula[çc]|cano|joelho|luva de \d/i, 'HIDRÁULICA'],
  [/esgoto|caixa de gordura|fossa|ralo/i, 'HIDRÁULICA E ESGOTO'],
  [/fechadura|porta|ma[çc]aneta|dobradi[çc]a|caixilho|divis[óo]ria|alizar|batente/i, 'CARPINTARIA'],
  [/pintura|pintar|tinta|massa corrida|l[áa]tex/i, 'PINTURA'],
  [/vidro|vidra[çc]/i, 'VIDRAÇARIA'],
  [/grade|solda|serralh|port[ãa]o met[áa]lico|corrim[ãa]o/i, 'SERRALHERIA'],
  [/piso|azulejo|alvenaria|reboco|argamassa|parede|forro|gesso|pastilha|revestimento/i, 'CIVIL'],
  [/ar condicionado|refrigera[çc]|geladeira|freezer/i, 'REFRIGERAÇÃO'],
];
// vence quem tem MAIS ocorrências, não quem vem primeiro na lista: a O.S.
// "troca de espude, anel de cera, parafuso de vaso, INTERRUPTOR, descargas"
// é hidráulica com um item elétrico no meio — pela ordem sairia ELÉTRICA
const deduz = (tabela: [RegExp, string][], ...textos: (string | null | undefined)[]): string => {
  const t = textos.filter(Boolean).join(' ');
  if (!t.trim()) return '';
  let melhor = '', pontos = 0;
  for (const [re, valor] of tabela) {
    const n = (t.match(new RegExp(re.source, 'gi')) || []).length;
    if (n > pontos) { pontos = n; melhor = valor; }
  }
  return melhor;
};

export const legendaOS = (os: OSCampo, med?: string, opts: { detalhado?: boolean } = {}): string => {
  const L: string[] = [];
  L.push(`*${refDaOS(os)}* — ${STATUS_LEGENDA[os.status] || os.status}`);

  // só entra na legenda o que tem CONTEÚDO: a equipe às vezes digita "." ou
  // "," só pra passar da validação de memória obrigatória, e isso ia pro
  // grupo como "Quantificação: ,"
  const temTexto = (s: string) => /[a-zA-ZÀ-ÿ0-9]/.test(s);
  const linha = (rot: string, val?: string | null) => {
    const v = String(val ?? '').trim();
    if (v && temTexto(v)) L.push(`${rot}: ${v}`);
  };
  // o serviço executado é a melhor fonte pra deduzir; o pedido do fiscal
  // entra junto porque muita O.S. só tem ele preenchido
  const textos = [os.servico, os.solicitado, os.materiais];

  linha('Unidade', os.unidade);
  // Local: o que a equipe digitou; se não digitou, deduz do texto
  linha('Local', (os as any).local || deduz(LOCAIS, ...textos));
  // Tipo NUNCA fica vazio: sem disciplina identificada é "OUTROS SERVIÇOS"
  linha('Tipo', (os.area || deduz(TIPOS, ...textos) || 'OUTROS SERVIÇOS').toUpperCase());
  linha('Criticidade', String(os.classificacao || os.tipo || '').toUpperCase());
  // Quantificação É a memória de cálculo (definição do Renan): "1 fechadura",
  // "Vidro 18×26" — é o número que vira item EMOP na medição. Sem memória a
  // linha não sai; NÃO cai em materiais, que é outra coisa (o que saiu do
  // almoxarifado, não o que foi medido).
  linha('Quantificação', os.memoria_calculo);
  // O modelo do grupo mostra só o que FOI FEITO. A descrição (pedido do
  // fiscal) só entra quando ainda não há execução — aí é o que temos.
  const pedido = String(os.solicitado ?? '').trim();
  const feito = String(os.servico ?? '').trim();
  if (feito) linha('Executado', feito);
  else linha('Descrição', pedido);
  linha('Executante', os.executor);

  // detalhe extra só quando pedido (gestão/medição) — no grupo o curto é melhor
  if (opts.detalhado) {
    linha('Materiais', os.materiais);
    linha('Memória de cálculo', os.memoria_calculo);
    linha('Conclusão', br(os.conclusao));
    linha('Medição', med || os.medicao);
  }
  return L.join('\n');
};

// baixa as fotos do Storage e devolve como File[] pro share nativo.
// Falha de rede em uma foto não derruba o compartilhamento: manda as
// que vieram (a legenda já diz quantas deveriam ser).
// v87: baixar 15 fotos no 4G da escola leva tempo REAL e antes não havia
// nenhum sinal na tela — o Renato achou que travou e clicou várias vezes,
// cada clique disparando um novo lote de downloads. Agora reporta progresso
// e cada foto tem prazo próprio: a que não vier em 20s fica de fora em vez
// de segurar o compartilhamento inteiro.
const buscarFotos = async (
  urls: string[], ref: string,
  aoProgredir?: (feitas: number, total: number) => void,
): Promise<File[]> => {
  const alvo = urls.slice(0, 30); // teto igual ao do formulário (v101: era 15)
  // v107: grava por ÍNDICE, não com push. Com push a posição no álbum era a
  // ordem em que cada download TERMINOU — a foto leve do "depois" chegava antes
  // da pesada do "antes", e o fiscal recebia a prova fora de ordem. Pior: o
  // corte do lote (maiorLoteAceito) tira as últimas do array, então "quem fica
  // de fora" era sorteio. É o mesmo defeito que a v103 matou no upload e que
  // sobreviveu aqui, do lado do download.
  const porIndice: (File | null)[] = new Array(alvo.length).fill(null);
  let feitas = 0;
  await Promise.all(alvo.map(async (u, i) => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(u, { signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) return;
      const b = await r.blob();
      const ext = (b.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      porIndice[i] = new File([b], `OS_${ref}_${i + 1}.${ext}`, { type: b.type || 'image/jpeg' });
    } catch { /* foto que não veio fica de fora */ }
    finally { feitas++; aoProgredir?.(feitas, alvo.length); }
  }));
  return porIndice.filter((f): f is File => !!f);   // ordem da O.S. preservada
};

export type ResultadoShare =
  | 'compartilhado'        // texto + TODAS as fotos
  | 'compartilhado-parcial' // texto + parte das fotos (o aparelho não aceitou todas)
  | 'compartilhado-sem-fotos' // só o texto — as fotos NÃO foram
  | 'copiado' | 'cancelado'
  | 'navegador-embutido'   // app aberto DENTRO do WhatsApp/Instagram — share não existe lá
  | 'erro-copiado'         // a folha foi recusada, MAS a legenda está na área de transferência
  | 'erro';                // a folha foi recusada E a cópia falhou — NADA ficou no aparelho

// v111 — NAVEGADOR EMBUTIDO (o "navegador de dentro" do WhatsApp/Instagram).
// O link do fiscal (v109) é tocado DENTRO do WhatsApp, e o app abre no
// navegador embutido dele — lá o compartilhamento nativo NÃO existe (ou vem
// capado e recusa). Foi o erro do Queiroz e do Tito em 24/09, no MESMO dia
// em que o link entrou no ar: todos na versão nova, e mesmo assim "o
// aparelho recusou". Salvar a O.S. funciona normalmente no embutido — só o
// envio pro grupo que não; a orientação é salvar ali e compartilhar depois
// pela LISTA, com o app aberto no Chrome/ícone.
// Sinais: celular SEM navigator.share, ou user agent de WebView ("; wv)")
// e dos apps que embutem navegador (WhatsApp/FBAN/FB_IAB/Instagram).
const ehCelular = /Android|iPhone|iPad/i.test(navigator.userAgent || '');
export const navegadorEmbutido = (): boolean =>
  ehCelular && (
    !('share' in navigator) ||
    /; wv\)|WhatsApp|FB_IAB|FBAN|Instagram|Line\//i.test(navigator.userAgent || '')
  );

// v111 — o MOTIVO técnico da última recusa (nome + mensagem do erro real).
// Vai escrito na mensagem da tela: o print que o campo manda no grupo passa
// a ser o próprio diagnóstico, em vez de "não funciona" sem pista.
let motivoErro = '';
export const motivoDoUltimoErro = () => motivoErro;

// v110 — cópia COM PROVA: só devolve true se o navegador CONFIRMOU a escrita.
// Depois de uma folha de compartilhamento recusada, o Chrome costuma negar
// também o clipboard ("document is not focused") — e até a v109 esse erro era
// engolido e a tela dizia "a legenda está copiada" com a área de transferência
// intacta: o operador colava no grupo o que estivesse lá de antes (caso do
// Leony, 24/09). O plano B (textarea + execCommand) salva parte dos casos em
// que o writeText moderno é negado.
export const copiarLegenda = async (txt: string): Promise<boolean> => {
  try { await navigator.clipboard.writeText(txt); return true; } catch { /* tenta o plano B */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
};

// O MÁXIMO que ESTE aparelho aceita numa folha de compartilhamento.
//
// O canShare do Android recusa lote grande (por peso total ou por número de
// arquivos) e cada fabricante corta num ponto diferente — por isso a mesma
// O.S. vai inteira no celular do Caleb e não vai no do Emiliano.
//
// v93 (regra do Renan 11/09): mandar o MÁXIMO que couber, seja 15 ou 3 —
// o que não pode é ir nada. A v92 testava só 15/10/8/5/3/2/1 e num aparelho
// que aceita 12 mandava 10, perdendo 2 fotos que caberiam. Agora desce de
// um em um e acha o teto exato. São no máximo 15 chamadas síncronas e
// baratas: não pesa no celular.
const maiorLoteAceito = (nav: any, files: File[]): File[] => {
  if (!files.length) return [];
  if (!nav.canShare) return [];           // aparelho sem suporte a arquivo
  for (let n = files.length; n >= 1; n--) {
    const lote = files.slice(0, n);
    try { if (nav.canShare({ files: lote })) return lote; } catch { /* tenta com uma a menos */ }
  }
  return [];
};

// =====================================================================
// v108 — PREPARAR e ENVIAR viraram DOIS PASSOS. O motivo é o seguinte.
//
// O navegador só abre a folha de compartilhamento se `navigator.share` for
// chamado dentro da JANELA DE ATIVAÇÃO do toque — poucos segundos depois de o
// dedo sair da tela. Até a v107 o fluxo era:
//     toque → BAIXA as fotos do Storage (até 20s) → escreve na área de
//     transferência (mais um await) → só então chama a folha.
// No sinal da escola o toque já tinha expirado quando a folha era pedida. O
// navegador recusava com NotAllowedError, o app devolvia 'erro' e a tela
// mandava o operador COLAR a legenda à mão e mandar as fotos pela galeria.
// Ele fazia isso e, em seguida, tocava no botão de novo — e o grupo recebia o
// cartão DUAS VEZES. É a duplicação que o Neilson vinha relatando, e ela não
// era duplo-toque: era o app pedindo a folha tarde demais.
//
// Agora: `prepararFotos` baixa (pode demorar o que for), e `enviarOS` chama a
// folha como PRIMEIRA COISA de um toque NOVO, sem nenhum await antes dela.
// A cópia para a área de transferência foi para DEPOIS do share, pelo mesmo
// motivo: ela era um await entre o dedo e a folha.
// =====================================================================
export const prepararFotos = async (
  os: OSCampo,
  aoProgredir?: (feitas: number, total: number) => void,
): Promise<File[]> => {
  const urls = os.foto_urls || [];
  if (!urls.length) return [];
  try { return await buscarFotos(urls, refDaOS(os), aoProgredir); } catch { return []; }
};

// NADA de await antes do nav.share. Se precisar mexer aqui, mantenha essa regra.
export const enviarOS = async (
  texto: string, fotos: File[], totalUrls: number,
): Promise<ResultadoShare> => {
  const nav = navigator as any;
  motivoErro = '';

  if (nav.share && fotos.length) {
    // REGRA DO RENAN (18/09): a legenda VAI SEMPRE junto com as fotos.
    // canShare é síncrono — não gasta a janela de ativação.
    const lote = maiorLoteAceito(nav, fotos);
    if (lote.length) {
      const faltam = Math.max(0, totalUrls - lote.length);
      const txt = faltam > 0
        ? `${texto}\n\n_${lote.length} de ${totalUrls} fotos — as outras ${faltam} estão no app._`
        : texto;
      try {
        await nav.share({ text: txt, files: lote });        // <<< primeira coisa
        // só depois de a folha ter aberto: a legenda na área de transferência,
        // para o caso de o aparelho engolir o texto
        copiarLegenda(txt);   // backup silencioso: se falhar, o envio já foi
        return faltam > 0 ? 'compartilhado-parcial' : 'compartilhado';
      } catch (e: any) {
        if (e?.name === 'AbortError') return 'cancelado';   // usuário fechou a folha
        motivoErro = `${e?.name || 'Erro'}: ${e?.message || e}`;
        // share existe mas foi recusado DENTRO de um navegador embutido:
        // o conserto não é tentar de novo, é abrir o app no Chrome/ícone
        if (navegadorEmbutido()) { copiarLegenda(txt); return 'navegador-embutido'; }
        // recusou: NÃO abre uma segunda folha. E o retorno DIZ se a legenda
        // ficou copiada de verdade — 'erro' seco significa que NADA ficou.
        return (await copiarLegenda(txt)) ? 'erro-copiado' : 'erro';
      }
    }
  }

  // sem foto para mandar — ou o aparelho não aceita nenhuma, ou o download
  // não veio, ou a O.S. não tem foto. Manda o texto e DIZ o que foi.
  if (nav.share) {
    try {
      await nav.share({ text: texto });
      copiarLegenda(texto);   // backup silencioso
      return totalUrls > 0 ? 'compartilhado-sem-fotos' : 'compartilhado';
    } catch (e: any) {
      if (e?.name === 'AbortError') return 'cancelado';
      motivoErro = `${e?.name || 'Erro'}: ${e?.message || e}`;
      if (navegadorEmbutido()) { copiarLegenda(texto); return 'navegador-embutido'; }
    }
  }

  // celular que chegou até aqui não tem navigator.share = navegador
  // embutido. NÃO é desktop: avisar para abrir no Chrome, não fingir cópia.
  if (navegadorEmbutido()) { copiarLegenda(texto); return 'navegador-embutido'; }

  // desktop: copia a legenda (as fotos o gestor pega no app/relatório)
  if (await copiarLegenda(texto)) return 'copiado';
  try { window.prompt('Copie a legenda:', texto); return 'copiado'; } catch { return 'erro'; }
};

// Compartilha no grupo: no celular abre a folha nativa (WhatsApp, e-mail…)
// com legenda + fotos; no desktop copia a legenda pra área de transferência.
export const compartilharOS = async (
  os: OSCampo, med?: string,
  opts: { detalhado?: boolean; aoProgredir?: (feitas: number, total: number) => void } = {},
): Promise<ResultadoShare> => {
  const texto = legendaOS(os, med, opts);
  const urls = os.foto_urls || [];
  const nav = navigator as any;

  // 1) share nativo COM fotos (celular) — é o caminho que resolve a dor
  //
  // v92: ATÉ AQUI ISTO FALHAVA CALADO. Se o canShare recusasse o lote, o
  // código caía no share só-texto e devolvia 'compartilhado' — a tela dizia
  // "enviado" e as fotos não iam. Foi o que aconteceu com o Emiliano.
  // Agora: tenta o lote inteiro, depois lotes menores, e o retorno DIZ o que
  // realmente foi.
  // v103 — ESTE RAMO É TERMINAL. Ele nunca mais escorre para o bloco 2.
  // Dois defeitos reais que estavam aqui, os dois com cara do caso do Neilson:
  //  (a) DUAS MENSAGENS. Se o `nav.share` com arquivos falhasse com qualquer
  //      coisa que não fosse o usuário cancelando, o catch não retornava e a
  //      execução caía no bloco 2, que abria uma SEGUNDA folha de
  //      compartilhamento para a mesma O.S. — a segunda sem foto nenhuma.
  //  (b) MENTIRA NA TELA. Se NENHUMA foto conseguisse ser baixada do Storage
  //      (sinal caindo na escola, storage restringido), `buscarFotos` devolvia
  //      lista vazia sem erro, os dois testes abaixo davam falso e o fluxo caía
  //      no bloco 2, devolvendo 'compartilhado'. A tela dizia "enviado: cartão
  //      + todas as fotos" com ZERO foto enviada. É a mesma dor do Emiliano que
  //      a v92 se propôs a matar, sobrevivendo num ramo que ela não fechou.
  // v108: virou um atalho de UM PASSO — baixa e envia em seguida. Continua
  // servindo a O.S. SEM FOTO (nada a baixar, o toque chega inteiro na folha) e
  // o desktop. Quem tem foto deve usar prepararFotos + enviarOS, senão o
  // download come a janela de ativação e o navegador recusa a folha.
  const fotos = await prepararFotos(os, opts.aoProgredir);
  return enviarOS(texto, fotos, urls.length);
};
