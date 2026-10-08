import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PackageMinus, PackagePlus, Save, Loader2, Trash2, Link2, Undo2, Pencil, Search, TrendingUp, BarChart3, Boxes, Wrench, Inbox, Camera, CheckCircle2, Siren, Construction, Plus, X } from 'lucide-react';
import { supabase } from '../services/supabaseClient';
import { osService } from '../services/osService';
import { OSCampo, refDaOS, EXECUTOR_OPTIONS, buscaNorm } from '../types';
import { MATERIAIS, UNIDADES, ORIGENS, MINIMO_PADRAO_PCT } from '../data/materiais';
import { ESCOLAS, fiscalDaEscola } from '../data/escolas';
import { UNIDADES_SAUDE, contratoDaUnidade } from '../data/unidadesSaude';
import { EQUIPES, CORRETIVA } from '../config';
import { hojeLocal } from '../config';

// =============================================================
// ALMOXARIFADO v2 (spec engenheiro REV 000) — painel do João:
// Estatística · Saída · Cadastro/Entrada · Estoque · Ferramentas
// · Solicitações. saldo = contagem inicial + entradas − saídas.
// =============================================================

interface Saida {
  id?: number; data: string; descricao: string; quantidade: number; unidade: string;
  os_ref: string; escola: string; origem: string; obs?: string | null;
  destinatario?: string | null; recebido?: boolean | null; criado_em?: string;
  contrato?: string | null; // v91: Educação | Saúde — deduzido da unidade
}
interface ItemEstoque {
  id?: number; descricao: string; categoria: string; unidade: string;
  qtd_minima: number; saldo_inicial: number;
  // v97: quando a contagem física foi feita. O saldo é a contagem mais o
  // movimento POSTERIOR a esta data — o que saiu antes não desconta.
  // Nulo = nunca contado (aparece como "sem contagem", sem alarme).
  contagem_em?: string | null;
}
interface Entrada {
  id?: number; data: string; descricao: string; quantidade: number; unidade: string;
  origem: string; nf_url?: string | null; obs?: string | null;
}
interface Ferramenta {
  id?: number; descricao: string; quantidade: number; status: string;
  com_quem?: string | null; obra?: string | null; desde?: string | null;
  obs?: string | null; // "O.S. x" quando a entrega foi vinculada a um serviço
}
interface Solicitacao {
  id?: number; data: string; solicitante: string; os_ref?: string | null;
  itens: string; status: string; criado_em?: string;
}
// ANDAIME (v76, pedido Renan 17/08): patrimônio PRÓPRIO, fora do contrato —
// NÃO entra em saida_material (que alimenta a medição/EMOP). Catálogo de
// peças + movimentos com retorno: disponível = total − movimentos abertos.
interface AndaimeItem {
  id?: number; descricao: string; quantidade_total: number; obs?: string | null;
}
interface AndaimeMov {
  id?: number; item_id: number; quantidade: number; obra?: string | null;
  com_quem?: string | null; os_ref?: string | null; saida: string; volta?: string | null;
}

const CATEGORIAS = ['ELÉTRICA', 'HIDRÁULICA', 'ESGOTO', 'CIVIL', 'PINTURA', 'FERRAMENTAS', 'EPI', 'DIVERSOS'];
const hoje = () => hojeLocal();
const norm = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// v72: o saldo é contagem inicial + entradas − saídas. Enquanto o banco
// tinha poucas linhas o .limit(400) pegava tudo; passando disso o saldo
// passou a ignorar em silêncio o consumo mais antigo (auditoria 24/07:
// 2.566 de 2.966 saídas fora da conta, 118 itens com saldo inflado).
// Agora pagina até acabar, com o desempate por id do v71 — o importão
// gravou centenas de linhas com o mesmo criado_em e sem isso a ordem
// muda entre páginas (linha repetida numa, engolida noutra).
const paginarTudo = async (tabela: string, teto = 12000) => {
  const PAGINA = 1000;
  const todas: any[] = [];
  const vistos = new Set<number>();
  for (let off = 0; off < teto; off += PAGINA) {
    const { data, error } = await supabase
      .from(tabela)
      .select('*')
      .order('criado_em', { ascending: false })
      .order('id', { ascending: false })
      .range(off, off + PAGINA - 1);
    if (error) return { data: todas, error };
    for (const r of (data as any[]) || []) {
      if (r.id != null && vistos.has(r.id)) continue;
      if (r.id != null) vistos.add(r.id);
      todas.push(r);
    }
    if (!data || data.length < PAGINA) break;
  }
  return { data: todas, error: null as any };
};

const SAIDA_VAZIA: Saida = { data: hoje(), descricao: '', quantidade: 1, unidade: 'UND', os_ref: '', escola: '', origem: 'ALMOXARIFADO', obs: '', destinatario: '' };
const ITEM_VAZIO: ItemEstoque = { descricao: '', categoria: 'DIVERSOS', unidade: 'UND', qtd_minima: 0, saldo_inicial: 0 };
const ENTRADA_VAZIA: Entrada = { data: hoje(), descricao: '', quantidade: 1, unidade: 'UND', origem: 'COMPRA', obs: '' };

type SubAba = 'stats' | 'saida' | 'cadastro' | 'estoque' | 'ferramentas' | 'andaime' | 'solicitacoes';

const AlmoxOS: React.FC<{ listaOS: OSCampo[]; ehGestor?: boolean; usuario?: string }> = ({ listaOS, ehGestor = false, usuario = '' }) => {
  const [sub, setSub] = useState<SubAba>('stats');
  const [saida, setSaida] = useState<Saida>({ ...SAIDA_VAZIA });
  const [saidas, setSaidas] = useState<Saida[]>([]);
  // v113 — CESTA (pedido do Renan 06/10). A saída era UM item por vez: para
  // mandar 5 materiais na mesma escola o João repetia escola, O.S. e quem
  // retirou cinco vezes. É por isso que a fila de "material declarado e ainda
  // não saiu do estoque" chegou a 422 O.S. — o balcão não acompanha.
  // Agora os itens se acumulam aqui e TUDO vai numa gravação só, dividindo
  // data, origem, O.S., escola, contrato e retirante.
  const [cesta, setCesta] = useState<{ descricao: string; quantidade: number; unidade: string }[]>([]);
  const refMaterial = useRef<HTMLInputElement>(null);
  const [itens, setItens] = useState<ItemEstoque[]>([]);
  const [entradas, setEntradas] = useState<Entrada[]>([]);
  const [ferramentas, setFerramentas] = useState<Ferramenta[]>([]);
  const [solicitacoes, setSolicitacoes] = useState<Solicitacao[]>([]);
  const [item, setItem] = useState<ItemEstoque>({ ...ITEM_VAZIO });
  const [entrada, setEntrada] = useState<Entrada>({ ...ENTRADA_VAZIA });
  const [nfFoto, setNfFoto] = useState<File | null>(null);
  const [novaFerr, setNovaFerr] = useState({ descricao: '', quantidade: 1 });
  const [andItens, setAndItens] = useState<AndaimeItem[]>([]);
  const [andMovs, setAndMovs] = useState<AndaimeMov[]>([]); // só os em aberto (volta null)
  const [novoAnd, setNovoAnd] = useState({ descricao: '', quantidade: 1 });
  const [andAberto, setAndAberto] = useState<number | null>(null);
  const [faltaAndaime, setFaltaAndaime] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState('');
  const [buscaLista, setBuscaLista] = useState('');
  const [catFiltro, setCatFiltro] = useState('TODAS');
  const [mostrar, setMostrar] = useState(30);
  const [faltaSQL, setFaltaSQL] = useState(false);
  const [ferrAberta, setFerrAberta] = useState<number | null>(null); // ficha da ferramenta
  // v90 (Renan 09/09): a entrada de compra só tinha INSERT — nunca aparecia
  // em tela e não dava para corrigir. Marcio e João erraram no cadastro do
  // estoque e ficaram com o erro somando saldo para sempre. Agora a entrada
  // é listada e editável, com formulário inline (nada de prompt: eles estão
  // no celular, e uma sequência de 6 prompts no telefone é inviável).
  const [entradaEdit, setEntradaEdit] = useState<Entrada | null>(null);
  const [verEntradas, setVerEntradas] = useState(false);
  const [apelidos, setApelidos] = useState<string[]>([]); // autopreenchimento acumulativo (REV002)
  const [mesFiltro, setMesFiltro] = useState('TODOS'); // histórico por mês (REV002)
  // contagem: Nicolas/Renan (REV001) + Lucas por ser o gestor geral
  const podeAjustarContagem = ['marcio', 'renan', 'lucas'].includes(usuario);

  const carregar = async () => {
    const [rs, ri, re, rf, rq] = await Promise.all([
      paginarTudo('saida_material'),
      supabase.from('estoque_item').select('*').order('descricao'),
      paginarTudo('entrada_material'),
      supabase.from('ferramenta').select('*').order('descricao'),
      supabase.from('solicitacao_material').select('*').order('criado_em', { ascending: false }).limit(100),
    ]);
    if (!rs.error && rs.data) setSaidas(rs.data as Saida[]);
    if (!ri.error && ri.data) setItens(ri.data as ItemEstoque[]);
    // vocabulário aprendido com a digitação (REV002)
    const ra = await supabase.from('apelido_material').select('digitado').order('usos', { ascending: false }).limit(500);
    if (!ra.error && ra.data) setApelidos((ra.data as { digitado: string }[]).map(a => a.digitado));
    if (!re.error && re.data) setEntradas(re.data as Entrada[]);
    if (!rf.error && rf.data) setFerramentas(rf.data as Ferramenta[]);
    if (!rq.error && rq.data) setSolicitacoes(rq.data as Solicitacao[]);
    setFaltaSQL(!!ri.error && /estoque_item/.test(ri.error.message));
    // andaime é módulo novo: sem o ANDAIME.sql a aba avisa em vez de quebrar
    const [ra1, ra2] = await Promise.all([
      supabase.from('andaime_item').select('*').order('descricao'),
      supabase.from('andaime_movimento').select('*').is('volta', null).order('saida'),
    ]);
    if (!ra1.error && ra1.data) setAndItens(ra1.data as AndaimeItem[]);
    if (!ra2.error && ra2.data) setAndMovs(ra2.data as AndaimeMov[]);
    setFaltaAndaime(!!ra1.error && /andaime/.test(ra1.error.message));
  };
  useEffect(() => { carregar(); }, []);

  // TEMPO REAL: pedido da equipe, saída, entrada ou devolução pinga na
  // tela do João sem apertar nada (debounce contra rajadas)
  useEffect(() => {
    let t: any;
    const bump = () => { clearTimeout(t); t = setTimeout(carregar, 1200); };
    const ch = supabase.channel('rt-almox');
    for (const tb of ['saida_material', 'solicitacao_material', 'estoque_item', 'entrada_material', 'ferramenta', 'andaime_item', 'andaime_movimento']) {
      ch.on('postgres_changes', { event: '*', schema: 'public', table: tb }, bump);
    }
    ch.subscribe();
    return () => { clearTimeout(t); supabase.removeChannel(ch); };
  }, []);

  // ===== saldo por item: MARCO ZERO (v97, decisão do Renan 12/09) =====
  //
  //    saldo = contagem física + movimento que aconteceu DEPOIS dela
  //
  // Antes era contagem + entradas − TODAS as saídas desde 06/01. Como só 21
  // dos 431 itens tinham contagem, os outros 410 viravam a soma do que já
  // saiu com sinal negativo — 404 itens no vermelho, lâmpada tubular 18W
  // marcando −1.109. Saldo calculado a partir de um ponto de partida que
  // nunca existiu não significa nada.
  //
  // Agora a contagem é uma FOTOGRAFIA com data (estoque_item.contagem_em).
  // O passado sai da conta: "saiu, saiu". Da contagem em diante o movimento
  // volta a valer — é isso que mantém as cores vivas: conta 100, saem 60, o
  // painel avisa "repor já".
  // O corte é POR ITEM (cada um tem a sua data de contagem), então indexar
  // o movimento uma vez só e depois filtrar por data dentro da lista curta
  // daquele item. Fazer a soma inteira a cada chamada seria 431 itens ×
  // 3.789 movimentos a cada renderização — no celular do João isso trava.
  const movimentoPor = useMemo(() => {
    const m: Record<string, { data: string; qtd: number }[]> = {};
    const por = (rows: { descricao: string; quantidade: number; data?: string }[], sinal: number) => {
      for (const r of rows) {
        const k = norm(r.descricao);
        (m[k] ||= []).push({ data: String(r.data || ''), qtd: sinal * Number(r.quantidade || 0) });
      }
    };
    por(entradas, +1);
    por(saidas, -1);   // devolução já entra negativa na saída, então soma sozinha
    return m;
  }, [entradas, saidas]);

  const diaDaContagem = (i: ItemEstoque) =>
    i.contagem_em ? String(i.contagem_em).slice(0, 10) : null;
  const saldoDe = (i: ItemEstoque) => {
    const desde = diaDaContagem(i);
    if (!desde) return 0;                    // sem contagem não há saldo
    const movs = movimentoPor[norm(i.descricao)] || [];
    let s = Number(i.saldo_inicial || 0);
    for (const mv of movs) if (mv.data && mv.data >= desde) s += mv.qtd;
    return s;
  };
  // v97: contado é quem TEM DATA de contagem — não quem tem saldo > 0.
  // Item contado e encontrado vazio é informação legítima (saldo zero,
  // alarme ligado); antes ele se confundia com item nunca contado.
  const temContagem = (i: ItemEstoque) => !!i.contagem_em;
  const semContagem = itens.filter(i => !temContagem(i));
  // mínimo efetivo: o cadastrado no item OU a % padrão do setor sobre a
  // contagem inicial (pedido Renan/Lucas 06/07 — só painel do João)
  const minimoDe = (i: ItemEstoque): { min: number; padrao: boolean } | null => {
    if (i.qtd_minima > 0) return { min: i.qtd_minima, padrao: false };
    const pct = MINIMO_PADRAO_PCT[i.categoria] ?? 15;
    if (pct > 0 && i.saldo_inicial > 0) return { min: i.saldo_inicial * pct / 100, padrao: true };
    return null;
  };
  // alerta do spec: sinalizar a 50% e a 20% da quantidade mínima
  const nivelDe = (i: ItemEstoque) => {
    if (!temContagem(i)) return null; // v72: sem contagem não há alarme real
    const m = minimoDe(i);
    if (!m) return null;
    const s = saldoDe(i);
    const suf = m.padrao ? ' · padrão setor' : '';
    if (s <= 0) return { rot: '🚨 EM FALTA', cls: 'bg-red-600 text-white border-red-600' };
    if (s <= m.min * 0.2) return { rot: '🔴 CRÍTICO' + suf, cls: 'bg-red-50 text-red-700 border-red-200' };
    if (s <= m.min * 0.5) return { rot: '🟠 repor já' + suf, cls: 'bg-orange-50 text-orange-700 border-orange-200' };
    if (s <= m.min) return { rot: '🟡 no mínimo' + suf, cls: 'bg-amber-50 text-amber-700 border-amber-200' };
    return null;
  };
  const emFalta = itens.filter(i => temContagem(i) && saldoDe(i) <= 0);
  const top10Acabando = itens
    .filter(temContagem)
    .map(i => ({ i, s: saldoDe(i), m: minimoDe(i) }))
    .filter(x => x.m)
    .map(x => ({ i: x.i, s: x.s, r: x.s / x.m!.min }))
    .sort((a, b) => a.r - b.r)
    .slice(0, 10);

  const ehDevolucao = (s: Saida) => s.quantidade < 0 || /devolu/i.test(s.origem || '');
  const hojeStr = hoje();
  const seteDias = hojeLocal(new Date(Date.now() - 7 * 86400000));
  const saidasHoje = saidas.filter(s => s.data === hojeStr && !ehDevolucao(s));
  const semOS = saidas.filter(s => !ehDevolucao(s) && !(s.os_ref || '').trim());
  // v72: resolver a ref digitada contra o banco de O.S. — sem isso um nº
  // inexistente ou uma fictícia velha (F-12) contava como VINCULADA e
  // sumia do radar. Aceita o nº oficial, a ref fictícia e o fict_ref
  // preservado depois da oficialização.
  const achaOS = (ref: string): OSCampo | null => {
    const r = (ref || '').trim().replace(/^O\.?S\.?\s*/i, '');
    if (!r) return null;
    return listaOS.find(o => refDaOS(o) === r)
      || listaOS.find(o => (o.fict_ref || '').toUpperCase() === r.toUpperCase())
      || null;
  };
  // saída que aponta para uma O.S. que não existe mais / nunca existiu
  const refOrfa = saidas.filter(s => !ehDevolucao(s) && (s.os_ref || '').trim() && !achaOS(s.os_ref));
  const pedidosAbertos = solicitacoes.filter(q => q.status === 'PEDIDO');
  // O.S. emergenciais em aberto (spec: só emergencial, pendente/executando)
  const emergAbertas = listaOS.filter(o => o.emergencial && ['Pendente', 'Executando', 'Material'].includes(o.status));

  // só O.S. VIVAS no dropdown (excluída/cancelada não recebe material —
  // refatoração sênior 06/07)
  const refsOS = listaOS
    .filter(os => !os.excluida && os.status !== 'Cancelada')
    .map(os => {
      const r = refDaOS(os);
      return { ref: r === 'S/Nº' ? '' : r, rotulo: `${r} — ${os.unidade}` };
    }).filter(r => r.ref);
  const escolheuOS = (v: string) => {
    const achada = listaOS.find(os => refDaOS(os) === v);
    setSaida(p => ({ ...p, os_ref: v, escola: achada ? achada.unidade : p.escola }));
  };

  // um destinatário confirma o recebimento no login dele (spec)
  const DESTINATARIOS = ['Equipe Leandro', 'Equipe Renato', ...EXECUTOR_OPTIONS];

  // O JOÃO É O CONTROLADOR DOS EMERGENCIAIS (Renan, 1º teste 06/07):
  // a equipe passa no balcão ANTES de registrar a O.S. — então a
  // fictícia nasce AQUI: prefixo pela equipe/encarregado que retira.
  // CORRIGIDO 07/07: renato/wellington estavam com as zonas invertidas
  // da era pré-v27 (fiscal Wellington = equipe L; fiscal Renato = M).
  // Renato agora é TAMBÉM o encarregado da equipe M (troca do Miqueias).
  // v100: este mapa era uma CÓPIA À MÃO do config e saiu de sincronia —
  // auditoria de 14/09 achou 'renato': 'M' aqui depois de o config já ter
  // passado a equipe do Renato para 'R' (01/09), e nenhum dos que entraram
  // desde então (Emiliano, Queiroz, Neilson, André, Abraão) constava. Quem
  // não estava no mapa tinha a O.S. do balcão caindo no F-nn legado.
  // Agora DERIVA de EQUIPES + CORRETIVA: pessoa nova no config entra aqui
  // sozinha, e não existe mais cópia para envelhecer.
  const PREFIXO_DEST: Record<string, string> = useMemo(() => {
    const m: Record<string, string> = {};
    for (const eq of Object.values(EQUIPES)) {
      m[norm(eq.apelido)] = eq.prefixo;               // "equipe leandro"
      for (const membro of eq.membros) m[norm(membro)] = eq.prefixo;
    }
    for (const c of Object.values(CORRETIVA)) {
      m[norm(c.executor)] = c.prefixo;
      m[norm(c.apelido)] = c.prefixo;
    }
    return m;
  }, []);
  const [gerarOS, setGerarOS] = useState(false);

  // v113: joga o material digitado na cesta e limpa material + quantidade
  // (a unidade FICA, porque costuma se repetir na mesma retirada), deixando
  // escola / O.S. / retirante como estão — que é o ponto de tudo isto.
  const addNaCesta = () => {
    const d = (saida.descricao || '').trim();
    if (!d) { setMsg('Escreva o material antes de adicionar.'); return; }
    if (!saida.quantidade || saida.quantidade <= 0) { setMsg('Quantidade precisa ser maior que zero.'); return; }
    setCesta(c => [...c, { descricao: d, quantidade: saida.quantidade, unidade: saida.unidade }]);
    setSaida(p => ({ ...p, descricao: '', quantidade: 1 }));
    setMsg('');
    setTimeout(() => refMaterial.current?.focus(), 0);
  };

  // v116 — TRAVA SÍNCRONA no Registrar saída (lição #4). O botão só fica
  // `disabled` depois que o React redesenha: dois toques no mesmo frame
  // passavam os DOIS — e com a cesta isso regrava a RETIRADA INTEIRA (e, com
  // "gerar O.S.", nascem DUAS emergenciais). A v113.1 fechou a janela do fim
  // da gravação; o ref fecha a do começo. Mesmo padrão do SALVAR da NovaOS.
  const emGravar = useRef(false);
  const salvarSaida = async (e: React.FormEvent) => {
    e.preventDefault();
    if (emGravar.current) return;
    emGravar.current = true;
    try { await salvarSaidaDeVerdade(); } finally { emGravar.current = false; setSalvando(false); }
  };

  const salvarSaidaDeVerdade = async () => {
    // v113: o que vai gravar é a CESTA mais o que estiver digitado agora —
    // assim ele pode somar 4 itens e salvar com o 5º ainda no campo, sem
    // precisar lembrar de "adicionar" o último.
    const itensSaida = [...cesta];
    const digitado = (saida.descricao || '').trim();
    if (digitado) {
      // v113: nada de descartar calado. Se ele escreveu o material e deixou a
      // quantidade em zero, a tela RECUSA — antes esse item simplesmente não
      // era gravado e a mensagem de sucesso não dizia que ele ficou de fora.
      if (!saida.quantidade || saida.quantidade <= 0) {
        setMsg(`Quantidade de "${digitado}" precisa ser maior que zero — ou apague o material para salvar só a lista.`);
        return;
      }
      itensSaida.push({ descricao: digitado, quantidade: saida.quantidade, unidade: saida.unidade });
    }
    if (itensSaida.length === 0) { setMsg('Escolha pelo menos um material.'); return; }
    let gerouAgora = false;
    const dest = (saida.destinatario || '').trim();
    // REV 001 do gestor: TODA saída tem retirante — é ele que confirma no login
    if (!dest) { setMsg('Informe QUEM RETIROU — regra do gestor: toda saída tem confirmação no login de quem levou.'); return; }
    let osRef = (saida.os_ref || '').trim();

    // v72: nº digitado que NÃO existe no banco não pode virar vínculo
    // fantasma. Até aqui gravava igual e ainda contava como "vinculada"
    // no painel — auditoria 24/07 achou 168 saídas assim (F-12, F-57...).
    // Nada se perde: o que ele digitou fica registrado na observação.
    let obsExtra = '';
    if (osRef && !achaOS(osRef)) {
      const ok = confirm(
        `A O.S. "${osRef}" não existe no sistema.\n\n` +
        `Pode ser número errado, O.S. que o fiscal ainda não emitiu, ou uma emergência antiga já oficializada.\n\n` +
        `OK = salvar SEM vínculo (fica anotado "${osRef}" na observação, p/ acertar depois)\n` +
        `Cancelar = voltar e corrigir o número`
      );
      if (!ok) return;
      obsExtra = `[O.S. digitada: ${osRef} — não encontrada no sistema]`;
      osRef = '';
    }

    // gera a O.S. EMERGENCIAL no balcão e já vincula a saída a ela
    if (gerarOS && !osRef) {
      if (!saida.escola.trim()) { setMsg('Para gerar a O.S. informe a ESCOLA.'); return; }
      if (!dest) { setMsg('Para gerar a O.S. informe QUEM RETIROU (é o executor dela).'); return; }
      setSalvando(true); setMsg('');
      const executor = EXECUTOR_OPTIONS.find(x => norm(x) === norm(dest)) || '';
      const novaOS: any = {
        numero: null, emergencial: true, tipo: 'Emergencial',
        unidade: saida.escola, fiscal: fiscalDaEscola(saida.escola),
        classificacao: 'Emergencial', entrada: hoje(), conclusao: null,
        executor, status: 'Executando', medicao: '',
        solicitado: saida.obs || 'Emergência atendida no almoxarifado',
        // v113: a O.S. emergencial nasce com a cesta INTEIRA nos materiais,
        // não só com o último item digitado
        servico: '', materiais: itensSaida.map(i => `${i.quantidade} ${i.unidade} ${i.descricao}`).join(' + '),
        memoria_calculo: '', foto_urls: []
      };
      const prefixo = PREFIXO_DEST[norm(dest)];
      const r = prefixo ? await osService.salvarEquipe(novaOS, prefixo) : await osService.salvar(novaOS);
      if (!r.ok || !r.os) { setSalvando(false); setMsg('Erro ao gerar a O.S.: ' + (r.erro || '?')); return; }
      osRef = refDaOS(r.os);
      gerouAgora = true;
      // v113: a O.S. já EXISTE no banco a partir daqui. Se o insert da saída
      // falhar logo abaixo e ele tocar em salvar de novo, antes nascia uma
      // SEGUNDA O.S. emergencial para a mesma retirada. Carimbando o número
      // no formulário e desligando o gatilho, o retry reaproveita esta.
      setGerarOS(false);
      setSaida(p => ({ ...p, os_ref: osRef }));
      setSalvando(false);
    }

    setSalvando(true); setMsg('');
    // v113: o cabeçalho é COMUM (data, origem, O.S., escola, retirante, obs,
    // contrato) e cada item da cesta vira uma linha com esse mesmo cabeçalho
    const payload: any = { ...saida, os_ref: osRef, destinatario: dest || null };
    delete payload.id; delete payload.criado_em;
    payload.recebido = dest ? false : null;
    // v72: com O.S. válida, a escola do material é a DA O.S. — o formulário
    // repete a escola do lançamento anterior p/ agilizar o balcão, e isso
    // vinha carimbando material na unidade errada (48 casos na auditoria).
    let avisoEscola = '';
    const osVinc = osRef ? achaOS(osRef) : null;
    if (osVinc && (osVinc.unidade || '').trim() && norm(osVinc.unidade) !== norm(payload.escola || '')) {
      avisoEscola = ` · escola ajustada p/ ${osVinc.unidade} (é a da O.S. ${osRef})`;
      payload.escola = osVinc.unidade;
    }
    if (obsExtra) payload.obs = [(payload.obs || '').trim(), obsExtra].filter(Boolean).join(' ');
    // v91 (Renan 09/09): o João é um só e atende os dois contratos. O
    // contrato sai da UNIDADE de destino, não de uma escolha dele — assim
    // o consumo da Educação e o da Saúde nascem separados sem depender de
    // ninguém lembrar de marcar. O campo é editável na tela para o caso
    // ambíguo (Prefeitura, Casa da Criança, Galpão Recanto).
    payload.contrato = (saida as any).contrato || contratoDaUnidade(payload.escola || '');
    // v113: UMA LINHA POR ITEM, todas com o mesmo cabeçalho. Cada material
    // continua sendo um registro próprio em saida_material (a medição/EMOP
    // soma por descrição — se virasse uma linha com texto "3 un X + 2 kg Y"
    // o consumo pararia de somar).
    const linhasCom = (base: any) => itensSaida.map(i => ({
      ...base, descricao: i.descricao, quantidade: i.quantidade, unidade: i.unidade
    }));
    let { error } = await supabase.from('saida_material').insert(linhasCom(payload));
    // banco sem as colunas novas (ALMOX-V2.sql / CONTRATO-SAIDA.sql pendente)
    // → salva sem elas em vez de perder a saída
    if (error && /contrato/i.test(error.message)) {
      delete payload.contrato;
      ({ error } = await supabase.from('saida_material').insert(linhasCom(payload)));
    }
    if (error && /obs|destinatario|recebido/i.test(error.message)) {
      delete payload.obs; delete payload.destinatario; delete payload.recebido; delete payload.contrato;
      ({ error } = await supabase.from('saida_material').insert(linhasCom(payload)));
    }
    if (error) { setSalvando(false); setMsg('Erro: ' + error.message); return; }
    // v113 — ORDEM IMPORTA. Antes o setSalvando(false) vinha AQUI, mas o
    // trabalho por item (status da O.S. + cadastro + apelido) continua por
    // mais alguns segundos abaixo. Com o botão reaberto e a cesta ainda
    // cheia, um segundo toque regravava a RETIRADA INTEIRA. Agora a cesta
    // esvazia assim que o insert passa (o laço abaixo usa itensSaida, que é
    // cópia local) e o botão só reabre no fim.
    setCesta([]);

    // SAIU MATERIAL = ESTÁ EXECUTANDO (regra Renan 10/07): O.S. Pendente
    // vinculada à saída muda de status sozinha — retirar material no
    // balcão é o sinal de que o serviço começou.
    let msgStatus = '';
    if (osRef) {
      const alvo = listaOS.find(o => refDaOS(o) === osRef && o.status === 'Pendente' && !o.excluida);
      if (alvo && alvo.id) {
        const { error: es } = await supabase.from('os_campo').update({ status: 'Executando' }).eq('id', alvo.id);
        if (!es) msgStatus = ` · O.S. ${osRef} passou p/ EXECUTANDO`;
      }
    }

    // REV002: material FORA do estoque → alerta + cadastro automático
    // com saldo NEGATIVO até a contagem real (gestão ajusta no 🧮)
    // v113: isto é POR ITEM — roda uma vez para cada material da cesta.
    const cadastrados: string[] = [];
    // v116: o mesmo material novo duas vezes na cesta (ex.: 2 linhas de
    // SIFÃO) cadastrava DOIS itens no estoque — `itens` só recarrega no fim
    const jaVisto = new Set<string>();
    for (const it of itensSaida) {
      const chave = norm(it.descricao);
      const jaCadastrado = jaVisto.has(chave) || itens.some(i => norm(i.descricao) === chave);
      jaVisto.add(chave);
      if (!jaCadastrado) {
        const { error: ec } = await supabase.from('estoque_item').insert([{
          descricao: it.descricao, categoria: 'DIVERSOS',
          unidade: it.unidade, qtd_minima: 0, saldo_inicial: 0
        }]);
        if (!ec) cadastrados.push(it.descricao);
      }
      // aprendizado de digitação (REV002): termo fora do catálogo vira sugestão
      if (!MATERIAIS.some(m => norm(m) === norm(it.descricao))) {
        const dig = it.descricao;
        const { data: ap } = await supabase.from('apelido_material').select('id,usos').eq('digitado', dig).limit(1);
        if (ap && ap.length > 0) {
          await supabase.from('apelido_material').update({ usos: (ap[0] as any).usos + 1 }).eq('id', (ap[0] as any).id);
        } else {
          await supabase.from('apelido_material').insert([{ digitado: dig, canonico: dig }]);
        }
      }
    }
    const alertaCad = cadastrados.length
      ? ` ⚠️ fora do estoque, CADASTRADO automático (saldo ficará NEGATIVO até a contagem da gestão): ${cadastrados.join(', ')}.`
      : '';

    const resumo = itensSaida.length === 1
      ? `${itensSaida[0].quantidade} ${itensSaida[0].unidade} ${itensSaida[0].descricao}`
      : `${itensSaida.length} itens (${itensSaida.map(i => `${i.quantidade} ${i.unidade} ${i.descricao}`).join(' · ')})`;
    setSalvando(false);
    setMsg(`✅ Saída: ${resumo}${osRef ? ' → O.S. ' + osRef : ''}${obsExtra ? ' ⚠️ SEM vínculo (nº anotado na obs)' : ''}${gerouAgora ? ' 🚨 (O.S. emergencial GERADA agora)' : ''}${dest ? ` · aguardando ✓ de ${dest}` : ''}${avisoEscola}${alertaCad}${msgStatus}`);
    setGerarOS(false);
    setSaida(p => ({ ...SAIDA_VAZIA, data: p.data, escola: p.escola, os_ref: osRef, origem: p.origem }));
    carregar();
  };

  // v91: item JÁ CADASTRADO com o nome digitado. Antes daqui o Cadastro
  // salvava por cima em silêncio (insert → on duplicate → update com o
  // payload inteiro): digitar um item existente e salvar ZERAVA a contagem
  // dele com o 0 padrão do formulário, sem avisar ninguém. Agora a tela
  // reconhece e assume que é edição.
  const itemExistente = useMemo(() => {
    const d = norm(item.descricao || '');
    if (!d) return null;
    return itens.find(i => norm(i.descricao) === d) || null;
  }, [item.descricao, itens]);

  const salvarItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!item.descricao.trim()) { setMsg('Informe o material/ferramenta.'); return; }
    setSalvando(true); setMsg('');
    const payload: any = { ...item }; delete payload.id;
    let { error } = await supabase.from('estoque_item').insert([payload]);
    if (error && /duplicate|unique/i.test(error.message)) {
      ({ error } = await supabase.from('estoque_item').update(payload).eq('descricao', item.descricao));
    }
    setSalvando(false);
    if (error) { setMsg(/estoque_item/.test(error.message) ? '⚠️ Rode o ALMOX-V2.sql no Supabase primeiro.' : 'Erro: ' + error.message); return; }
    setMsg(itemExistente
      ? `✏️ ${item.descricao} atualizado (contagem ${item.saldo_inicial} · mín. ${item.qtd_minima} ${item.unidade}).`
      : `✅ ${item.descricao} no catálogo (mín. ${item.qtd_minima} ${item.unidade}).`);
    setItem({ ...ITEM_VAZIO }); carregar();
  };
  // puxa os valores atuais do item para o formulário — sem isso o João
  // "edita" contra um formulário em branco e grava zero por engano
  const puxarExistente = () => {
    if (!itemExistente) return;
    setItem({
      descricao: itemExistente.descricao, categoria: itemExistente.categoria,
      unidade: itemExistente.unidade, qtd_minima: itemExistente.qtd_minima,
      saldo_inicial: itemExistente.saldo_inicial,
    } as ItemEstoque);
    setMsg(`Valores atuais de ${itemExistente.descricao} carregados — corrija e salve.`);
  };

  // v116: mesma trava síncrona da saída — toque duplo aqui DOBRAVA a entrada
  // e o saldo do estoque inteiro ficava errado até alguém editar
  const emGravarEntrada = useRef(false);
  const salvarEntrada = async (e: React.FormEvent) => {
    e.preventDefault();
    if (emGravarEntrada.current) return;
    emGravarEntrada.current = true;
    try { await salvarEntradaDeVerdade(); } finally { emGravarEntrada.current = false; setSalvando(false); }
  };

  const salvarEntradaDeVerdade = async () => {
    if (!entrada.descricao.trim()) { setMsg('Informe o material da entrada.'); return; }
    setSalvando(true); setMsg('');
    let nf_url: string | null = null;
    if (nfFoto) {
      const r = await osService.uploadFoto(nfFoto);   // v103: agora devolve o motivo
      nf_url = r.url;
      if (!r.url) { setSalvando(false); setMsg('Foto da NF não subiu: ' + (r.erro || 'falha desconhecida')); return; }
    }
    const payload: any = { ...entrada, nf_url }; delete payload.id;
    const { error } = await supabase.from('entrada_material').insert([payload]);
    setSalvando(false);
    if (error) { setMsg(/entrada_material/.test(error.message) ? '⚠️ Rode o ALMOX-V2.sql no Supabase primeiro.' : 'Erro: ' + error.message); return; }
    setMsg(`✅ Entrada: ${entrada.quantidade} ${entrada.unidade} ${entrada.descricao}${nf_url ? ' 🧾 NF anexada' : (nfFoto ? ' ⚠️ NF falhou no envio' : '')}`);
    setEntrada({ ...ENTRADA_VAZIA }); setNfFoto(null); carregar();
  };

  // v90: corrigir uma entrada já lançada. O saldo é contagem + entradas −
  // saídas, então uma quantidade errada aqui distorce o estoque inteiro até
  // alguém arrumar — por isso editar é obrigatório, não conveniência.
  const salvarEdicaoEntrada = async () => {
    if (!entradaEdit || !entradaEdit.id) return;
    const q = Number(entradaEdit.quantidade);
    if (!entradaEdit.descricao.trim()) { setMsg('Informe o material.'); return; }
    if (isNaN(q) || q < 0) { setMsg('Quantidade inválida.'); return; }
    setSalvando(true);
    const { error } = await supabase.from('entrada_material').update({
      data: entradaEdit.data, descricao: entradaEdit.descricao.trim(), quantidade: q,
      unidade: entradaEdit.unidade, origem: entradaEdit.origem, obs: entradaEdit.obs || null,
    }).eq('id', entradaEdit.id);
    setSalvando(false);
    if (error) { setMsg('Erro: ' + error.message); return; }
    setMsg(`✏️ Entrada corrigida: ${q} ${entradaEdit.unidade} ${entradaEdit.descricao.trim()}.`);
    setEntradaEdit(null); carregar();
  };
  const apagarEntrada = async (en: Entrada) => {
    if (!en.id) return;
    if (!confirm(`Apagar a entrada de ${en.quantidade} ${en.unidade} "${en.descricao}" (${en.data})?\n\nO saldo do estoque cai ${en.quantidade} ${en.unidade}.\nUse só para lançamento ERRADO ou de teste.`)) return;
    const { error } = await supabase.from('entrada_material').delete().eq('id', en.id);
    if (error) {
      // a política de DELETE do ALMOX-V2.sql lista e-mails nominais — quem
      // não está nela recebe 0 linhas afetadas em vez de erro explícito
      setMsg(/permission|policy|row-level/i.test(error.message)
        ? '⛔ Seu login não tem permissão para apagar entrada. Peça ao João ou à gestão.'
        : 'Erro: ' + error.message);
      return;
    }
    setMsg(`🗑 Entrada de ${en.quantidade} ${en.unidade} ${en.descricao} apagada.`);
    setEntradaEdit(null); carregar();
  };

  const criarFerramenta = async () => {
    if (!novaFerr.descricao.trim()) return;
    const { error } = await supabase.from('ferramenta').insert([{ descricao: novaFerr.descricao, quantidade: novaFerr.quantidade }]);
    if (error) { setMsg(/ferramenta/.test(error.message) ? '⚠️ Rode o ALMOX-V2.sql primeiro.' : 'Erro: ' + error.message); return; }
    setNovaFerr({ descricao: '', quantidade: 1 }); carregar();
  };
  const entregarFerr = async (f: Ferramenta) => {
    const quem = prompt(`Entregar "${f.descricao}" para quem? (encarregado/equipe)`); if (!quem) return;
    const obra = prompt('Em qual obra/escola?') || '';
    // elo opcional com a O.S. (Renan/Lucas 06/07): rastreia não só COM
    // QUEM está, mas EM QUAL SERVIÇO — sem virar baixa de estoque
    const osRef = (prompt('Vinculada a alguma O.S.? (opcional — nº, L/M-nº ou F-nº)') || '').trim();
    await supabase.from('ferramenta').update({
      status: 'EM CAMPO', com_quem: quem.trim(), obra, desde: hoje(),
      obs: osRef ? `O.S. ${osRef}` : null
    }).eq('id', f.id);
    carregar();
  };
  const receberFerr = async (f: Ferramenta) => {
    await supabase.from('ferramenta').update({ status: 'ESTOQUE', com_quem: null, obra: null, desde: null, obs: null }).eq('id', f.id);
    carregar();
  };
  // Lápis COMPLETO da ferramenta (pedido Renan 22/07): João corrige
  // modelo/descrição e quantidade em qualquer situação; se estiver EM
  // CAMPO, segue para com quem / obra / O.S. — Enter mantém o atual
  const editarFerr = async (f: Ferramenta) => {
    const desc = prompt('Ferramenta (modelo/descrição):', f.descricao); if (desc == null || !desc.trim()) return;
    const qS = prompt('Quantidade:', String(f.quantidade)); if (qS == null) return;
    const q = parseFloat(qS.replace(',', '.'));
    const payload: any = { descricao: desc.trim(), quantidade: isNaN(q) || q <= 0 ? f.quantidade : q };
    if (f.status === 'EM CAMPO') {
      const quem = prompt('Com quem está?', f.com_quem || ''); if (quem == null) return;
      const obra = prompt('Em qual obra/escola?', f.obra || ''); if (obra == null) return;
      const osAtual = (f.obs || '').replace(/^O\.S\.\s*/i, '').trim();
      const osRef = (prompt('O.S. vinculada (vazio = sem vínculo):', osAtual) ?? osAtual).trim();
      payload.com_quem = quem.trim() || f.com_quem;
      payload.obra = obra.trim() || null;
      payload.obs = osRef ? `O.S. ${osRef}` : null;
    }
    const { error } = await supabase.from('ferramenta').update(payload).eq('id', f.id);
    if (error) { setMsg('Erro: ' + error.message); return; }
    setMsg(`✏️ ${desc.trim()} atualizado.`); carregar();
  };
  // apagar cadastro errado (Renan 22/07) — NÃO é devolução: devolução
  // é o botão "← voltou". A RLS do banco já autoriza o João.
  const excluirFerr = async (f: Ferramenta) => {
    const alerta = f.status === 'EM CAMPO' ? `\n⚠️ Atenção: ela consta EM CAMPO com ${f.com_quem || '?'}.` : '';
    if (!confirm(`Apagar "${f.descricao}" da lista de ferramentas?${alerta}\n(Use só se o cadastro estiver errado — devolução é o "← voltou".)`)) return;
    const { error } = await supabase.from('ferramenta').delete().eq('id', f.id);
    if (error) { setMsg('Erro: ' + error.message); return; }
    setMsg(`🗑 ${f.descricao} apagada da lista de ferramentas.`); carregar();
  };

  // ===== ANDAIME (patrimônio fora do contrato — v76) =====
  const disponivelAnd = (i: AndaimeItem) =>
    Number(i.quantidade_total || 0) - andMovs.filter(m => m.item_id === i.id).reduce((t, m) => t + Number(m.quantidade || 0), 0);
  const criarAndaime = async () => {
    if (!novoAnd.descricao.trim()) { setMsg('Informe a peça de andaime.'); return; }
    const { error } = await supabase.from('andaime_item').insert([{ descricao: novoAnd.descricao.trim().toUpperCase(), quantidade_total: novoAnd.quantidade }]);
    if (error) { setMsg(/andaime/.test(error.message) ? '⚠️ Rode o ANDAIME.sql primeiro (SQL Editor).' : 'Erro: ' + error.message); return; }
    setNovoAnd({ descricao: '', quantidade: 1 }); setMsg('✅ Peça de andaime cadastrada.'); carregar();
  };
  // envio PARCIAL por natureza: andaime sai em lote (12 painéis p/ uma escola)
  const enviarAndaime = async (i: AndaimeItem) => {
    const disp = disponivelAnd(i);
    if (disp <= 0) { setMsg(`Sem saldo no pátio de ${i.descricao}.`); return; }
    const qtd = parseFloat(prompt(`Quantas unidades de "${i.descricao}"? (no pátio: ${disp})`, String(disp)) || '');
    if (!qtd || qtd <= 0) return;
    if (qtd > disp) { setMsg(`Só há ${disp} no pátio de ${i.descricao}.`); return; }
    const obra = prompt('Para qual obra/escola?'); if (obra == null || !obra.trim()) return;
    const quem = prompt('Com quem (responsável)?') || '';
    const { error } = await supabase.from('andaime_movimento').insert([{ item_id: i.id, quantidade: qtd, obra: obra.trim(), com_quem: quem.trim() || null, saida: hoje() }]);
    if (error) { setMsg('Erro: ' + error.message); return; }
    setMsg(`🏗 ${qtd}× ${i.descricao} → ${obra.trim()}.`); carregar();
  };
  const voltouAndaime = async (m: AndaimeMov, i: AndaimeItem) => {
    if (!confirm(`Confirmar retorno de ${m.quantidade}× ${i.descricao} de ${m.obra || '?'}?`)) return;
    const { error } = await supabase.from('andaime_movimento').update({ volta: hoje() }).eq('id', m.id);
    if (error) { setMsg('Erro: ' + error.message); return; }
    setMsg(`↩️ ${m.quantidade}× ${i.descricao} de volta ao pátio.`); carregar();
  };
  const editarAndaime = async (i: AndaimeItem) => {
    const desc = prompt('Peça (descrição):', i.descricao); if (desc == null || !desc.trim()) return;
    const qt = parseFloat(prompt('Quantidade TOTAL (patrimônio):', String(i.quantidade_total)) || '');
    if (!qt || qt <= 0) return;
    const { error } = await supabase.from('andaime_item').update({ descricao: desc.trim().toUpperCase(), quantidade_total: qt }).eq('id', i.id);
    if (error) { setMsg('Erro: ' + error.message); return; }
    setMsg(`✏️ ${desc.trim()} atualizado.`); carregar();
  };
  const excluirAndaime = async (i: AndaimeItem) => {
    const fora = andMovs.filter(m => m.item_id === i.id).length;
    if (!confirm(`Apagar "${i.descricao}" do andaime?${fora ? `\n⚠️ Há ${fora} movimento(s) em aberto — somem junto.` : ''}\n(Use só p/ cadastro errado — retorno é o "← voltou".)`)) return;
    const { error } = await supabase.from('andaime_item').delete().eq('id', i.id);
    if (error) { setMsg('Erro: ' + error.message); return; }
    setMsg(`🗑 ${i.descricao} apagado do andaime.`); carregar();
  };

  // REV 001 do gestor + pedido Renan 22/07: João edita descrição,
  // CATEGORIA, unidade e mínimo de qualquer item; a CONTAGEM (saldo
  // inicial) a gestão ajusta em tudo e o João nas FERRAMENTAS e EPI
  const editarItem = async (i: ItemEstoque) => {
    const desc = prompt('Descrição do item:', i.descricao); if (desc == null || !desc.trim()) return;
    const catS = prompt(`Categoria (${CATEGORIAS.join(' / ')}):`, i.categoria); if (catS == null) return;
    const cat = CATEGORIAS.find(c => norm(c) === norm(catS.trim())) || i.categoria;
    const un = prompt('Unidade (UND, M, KG…):', i.unidade) || i.unidade;
    const minS = prompt('Quantidade MÍNIMA (alerta):', String(i.qtd_minima)); if (minS == null) return;
    const min = parseFloat(minS.replace(',', '.'));
    const { error } = await supabase.from('estoque_item')
      .update({ descricao: desc.trim(), categoria: cat, unidade: un.trim(), qtd_minima: isNaN(min) ? i.qtd_minima : min })
      .eq('id', i.id);
    if (error) { setMsg('Erro: ' + error.message); return; }
    setMsg(`✏️ ${desc.trim()} (${cat}) atualizado.`); carregar();
  };
  // João ajusta a contagem só nas categorias dele (FERRAMENTAS/EPI);
  // nos consumíveis a separação de funções da REV001 continua valendo
  const podeContagemItem = (i: ItemEstoque) =>
    podeAjustarContagem || (usuario === 'joao' && (i.categoria === 'FERRAMENTAS' || i.categoria === 'EPI'));
  // REV002: excluir item do estoque — só gestão (RLS já restringe no banco)
  const excluirItem = async (i: ItemEstoque) => {
    if (!confirm(`Excluir "${i.descricao}" do catálogo do estoque?\n(As saídas históricas dele NÃO são apagadas.)`)) return;
    const { error } = await supabase.from('estoque_item').delete().eq('id', i.id);
    if (error) { setMsg('Erro: ' + error.message); return; }
    setMsg(`🗑 ${i.descricao} removido do catálogo.`); carregar();
  };
  const ajustarContagem = async (i: ItemEstoque) => {
    const marco = i.contagem_em ? new Date(i.contagem_em).toLocaleDateString('pt-BR') : null;
    const s = prompt(
      `CONTAGEM física de "${i.descricao}"\n` +
      (marco ? `contagem atual: ${i.saldo_inicial} ${i.unidade} (de ${marco})\n` : 'nunca foi contado\n') +
      `\nO número que você digitar vale a partir de HOJE: o que saiu antes\n` +
      `não desconta, e o que sair daqui pra frente desconta.`,
      String(i.saldo_inicial));
    if (s == null) return;
    const v = parseFloat(s.replace(',', '.'));
    if (isNaN(v) || v < 0) { setMsg('Valor inválido.'); return; }
    // v97: contar é carimbar a data. Sem ela o saldo não sabe a partir de
    // quando contar o movimento — era isso que fazia 404 itens ficarem
    // negativos, somando saída desde janeiro contra contagem nenhuma.
    const payload: any = { saldo_inicial: v, contagem_em: new Date().toISOString() };
    let { error } = await supabase.from('estoque_item').update(payload).eq('id', i.id);
    if (error && /contagem_em/i.test(error.message)) {   // banco sem a 0008
      delete payload.contagem_em;
      ({ error } = await supabase.from('estoque_item').update(payload).eq('id', i.id));
      if (!error) { setMsg(`🧮 ${i.descricao} = ${v}. ⚠️ Rode a migration 0008 — sem ela a data da contagem não é gravada.`); carregar(); return; }
    }
    if (error) { setMsg('Erro: ' + error.message); return; }
    setMsg(`🧮 ${i.descricao} contado: ${v} ${i.unidade}. Vale a partir de hoje.`); carregar();
  };

  const marcarSeparado = async (q: Solicitacao) => {
    await supabase.from('solicitacao_material').update({ status: 'SEPARADO' }).eq('id', q.id);
    carregar();
  };

  // === PEDIDO → SAÍDA sem redigitar (Renan 12/07): quebra o texto do
  // pedido em itens (quebra de linha, vírgula ou ; separam), estima
  // quantidade/unidade e gera as saídas já vinculadas à O.S. e ao
  // retirante. recebido=null: o RECEBI da equipe é feito no próprio
  // pedido (não duplica confirmação). João corrige qtd depois na lista.
  const parsePedido = (texto: string) =>
    (texto || '').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean).map(p => {
      const m = p.match(/^(\d+(?:[.,]\d+)?)\s+(.*)$/);
      let quantidade = 1, resto = p;
      if (m) { quantidade = parseFloat(m[1].replace(',', '.')) || 1; resto = m[2].trim(); }
      let unidade = 'UND';
      const toks = resto.split(/\s+/);
      if (toks.length > 1 && UNIDADES.some(x => norm(x) === norm(toks[0]))) { unidade = toks[0].toUpperCase(); resto = toks.slice(1).join(' '); }
      return { descricao: resto || p, quantidade, unidade };
    });

  const gerandoRef = React.useRef(false);
  const gerarSaidasDoPedido = async (q: Solicitacao) => {
    if (gerandoRef.current) return;
    const itens = parsePedido(q.itens);
    if (itens.length === 0) { setMsg('Pedido sem itens para gerar.'); return; }
    const refOS = (q.os_ref || '').replace(/^O\.?S\.?\s*/i, '').trim();
    const escola = refOS ? (listaOS.find(o => refDaOS(o) === refOS || String(o.numero ?? '') === refOS)?.unidade || '') : '';
    const dest = q.solicitante.includes('·') ? q.solicitante.split('·').pop()!.trim() : q.solicitante;
    const previa = itens.map(i => `• ${i.quantidade} ${i.unidade} ${i.descricao}`).join('\n');
    if (!confirm(`Gerar ${itens.length} saída(s) deste pedido de ${q.solicitante}?\n\n${previa}\n\nDá baixa no estoque e vincula à O.S. ${refOS || '(sem O.S.)'}. Ajuste as quantidades depois na aba Saída.`)) return;
    gerandoRef.current = true; setSalvando(true); setMsg('');
    const linhas = itens.map(i => ({
      data: hoje(), descricao: i.descricao, quantidade: i.quantidade, unidade: i.unidade,
      os_ref: refOS || null, escola, origem: 'ALMOXARIFADO',
      obs: `Pedido #${q.id} · ${q.solicitante}`, destinatario: dest, recebido: null,
    }));
    let { error } = await supabase.from('saida_material').insert(linhas);
    if (error && /obs|destinatario|recebido/i.test(error.message)) {
      const semNovas = linhas.map(l => ({
        data: l.data, descricao: l.descricao, quantidade: l.quantidade,
        unidade: l.unidade, os_ref: l.os_ref, escola: l.escola, origem: l.origem,
      }));
      ({ error } = await supabase.from('saida_material').insert(semNovas));
    }
    if (!error) await supabase.from('solicitacao_material').update({ status: 'SEPARADO' }).eq('id', q.id);
    gerandoRef.current = false; setSalvando(false);
    if (error) { setMsg('Erro ao gerar saídas: ' + error.message); return; }
    setMsg(`✅ ${itens.length} saída(s) geradas do pedido de ${q.solicitante}${refOS ? ' → O.S. ' + refOS : ''}. Pedido marcado como SEPARADO.`);
    carregar();
  };

  // SERVIÇO REALIZADO pela saída (Renan 22/07): o João auxilia o
  // operacional preenchendo o "serviço executado" da O.S. vinculada
  // sem sair do almoxarifado. Pré-carrega o texto atual da O.S.
  const preencherServico = async (s: Saida) => {
    const ref = ((s.os_ref || '').trim()).replace(/^O\.?S\.?\s*/i, '');
    if (!ref) { setMsg('Esta saída não tem O.S. vinculada — use o lápis para vincular primeiro.'); return; }
    const alvo = listaOS.find(o => refDaOS(o) === ref || String(o.numero ?? '') === ref);
    if (!alvo || !alvo.id) { setMsg(`Não achei a O.S. ${ref} na lista — confira o número.`); return; }
    const atual = (alvo.servico || '').trim();
    const novo = prompt(`SERVIÇO REALIZADO na O.S. ${ref} — ${alvo.unidade}\n(texto atual pré-carregado; edite/complete e OK):`, atual);
    if (novo == null || novo.trim() === atual) return;
    const { error } = await supabase.from('os_campo').update({ servico: novo.trim() }).eq('id', alvo.id);
    if (error) { setMsg('Erro: ' + error.message); return; }
    setMsg(`📝 Serviço realizado gravado na O.S. ${ref}.`);
  };

  // ver/corrigir o texto completo do pedido (textos longos que truncavam)
  const editarPedido = async (q: Solicitacao) => {
    const novo = prompt('Itens do pedido (um por linha; João pode corrigir):', q.itens);
    if (novo == null || novo.trim() === q.itens) return;
    const { error } = await supabase.from('solicitacao_material').update({ itens: novo.trim() }).eq('id', q.id);
    if (error) { setMsg('Erro: ' + error.message); return; }
    setMsg('✏️ Pedido atualizado.'); carregar();
  };
  // auto-resposta do spec: cada linha do pedido casada contra o estoque
  const checaLinha = (linha: string): { ok: boolean | null; txt: string } => {
    const l = norm(linha);
    const achado = itens.find(i => {
      const palavras = norm(i.descricao).split(/[^a-z0-9]+/).filter(w => w.length > 3);
      return palavras.some(w => l.includes(w));
    });
    if (!achado) return { ok: null, txt: 'conferir' };
    // v72: sem contagem o app não pode afirmar "ZERADO" — manda conferir
    if (!temContagem(achado)) return { ok: null, txt: 'conferir (s/ contagem)' };
    return saldoDe(achado) > 0 ? { ok: true, txt: `tem (${saldoDe(achado)} ${achado.unidade})` } : { ok: false, txt: 'ZERADO' };
  };

  const excluirSaida = async (s: Saida) => {
    if (!s.id || !confirm(`Excluir ${s.quantidade} ${s.unidade} ${s.descricao}?`)) return;
    await supabase.from('saida_material').delete().eq('id', s.id); carregar();
  };
  const devolver = async (s: Saida) => {
    const resp = prompt(`Quantas ${s.unidade} de "${s.descricao}" VOLTARAM pro estoque?\n(saíram ${s.quantidade}${s.os_ref ? ' na O.S. ' + s.os_ref : ''})`);
    if (resp == null) return;
    const q = parseFloat(resp.replace(',', '.'));
    if (!q || q <= 0 || q > s.quantidade) { setMsg('Quantidade de devolução inválida.'); return; }
    const { error } = await supabase.from('saida_material').insert([{ data: hoje(), descricao: s.descricao, quantidade: -q, unidade: s.unidade, os_ref: s.os_ref || null, escola: s.escola, origem: 'DEVOLUÇÃO' }]);
    if (error) { setMsg('Erro: ' + error.message); return; }
    setMsg(`↩ +${q} ${s.unidade} ${s.descricao} de volta ao saldo.`); carregar();
  };
  // LÁPIS COMPLETO DA SAÍDA (Renan 21/07): o João corrige erro de
  // lançamento — MATERIAL, Nº DA O.S. e DATA (além da quantidade).
  // Enter mantém o valor atual; O.S. vazia desvincula.
  const editarSaida = async (s: Saida) => {
    const desc = prompt('MATERIAL (Enter mantém):', s.descricao); if (desc == null) return;
    const refN = prompt('Nº da O.S. vinculada (Enter mantém · apagar tudo desvincula):', s.os_ref || ''); if (refN == null) return;
    const dataN = prompt('DATA da saída (dd/mm/aaaa · Enter mantém):', (s.data || '').split('-').reverse().join('/')); if (dataN == null) return;
    const qtN = prompt(`QUANTIDADE em ${s.unidade} (Enter mantém):`, String(s.quantidade)); if (qtN == null) return;
    const upd: any = {};
    if (desc.trim() && desc.trim() !== s.descricao) upd.descricao = desc.trim().toUpperCase();
    const r = refN.trim().replace(/^O\.?S\.?\s*/i, '');
    if (r !== ((s.os_ref || '').trim())) upd.os_ref = (r || null);
    const dTxt = dataN.trim();
    let dISO = '';
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(dTxt)) { const p = dTxt.split('/'); dISO = `${p[2]}-${p[1]}-${p[0]}`; }
    else if (/^\d{4}-\d{2}-\d{2}$/.test(dTxt)) { dISO = dTxt; }
    if (dISO && dISO !== s.data) upd.data = dISO;
    const q = parseFloat(qtN.replace(',', '.'));
    if (!isNaN(q) && q > 0 && q !== s.quantidade) upd.quantidade = q;
    if (Object.keys(upd).length === 0) { setMsg('Nada alterado.'); return; }
    const { error } = await supabase.from('saida_material').update(upd).eq('id', s.id);
    if (error) { setMsg('Erro ao corrigir: ' + error.message); return; }
    setMsg('✏️ Saída corrigida' + (upd.os_ref !== undefined ? ` · O.S. ${upd.os_ref ?? '(desvinculada)'}` : '') + '.');
    carregar();
  };
  const confirmarRecebidoManual = async (s: Saida) => {
    await supabase.from('saida_material').update({ recebido: true }).eq('id', s.id); carregar();
  };

  // vocabulário único p/ autopreenchimento em TODAS as funções (REV002):
  // catálogo fixo + itens do estoque + termos APRENDIDOS da digitação
  const VOCABULARIO = Array.from(new Set([
    ...MATERIAIS,
    ...itens.map(i => i.descricao),
    ...apelidos,
  ]));

  // v87: O.S. em que a equipe DECLAROU material no texto e que ainda não
  // têm nenhuma saída vinculada — é o buraco que o João apontou (o material
  // usado na emergência não aparecia no histórico do estoque).
  const declaradasSemSaida = useMemo(() => {
    const comSaida = new Set(saidas.map(s => (s.os_ref || '').trim()).filter(Boolean));
    return (listaOS || [])
      .filter(o => !o.excluida && o.status !== 'Cancelada'
        && (o.materiais || '').trim().length > 3
        && !comSaida.has(refDaOS(o)))
      .sort((a, b) => (b.id || 0) - (a.id || 0));
  }, [listaOS, saidas]);

  // trava da medição vigente nas saídas (REV002): fora do mês vigente = só gestão
  const mesVigente = hoje().slice(0, 7);
  const travadaSaida = (s: Saida) => !ehGestor && (s.data || '').slice(0, 7) !== mesVigente;
  const mesesDisponiveis = Array.from(new Set<string>(saidas.map(s => (s.data || '').slice(0, 7)).filter(Boolean))).sort().reverse();

  const inputCls = 'w-full border border-stone-200 rounded-lg px-3 py-2.5 text-sm bg-stone-50 outline-none focus:border-fpv-500';
  const SubBtn = ({ id, icon: Icon, rot, badge }: { id: SubAba; icon: any; rot: string; badge?: number }) => (
    <button onClick={() => setSub(id)}
      className={`flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-full border whitespace-nowrap ${sub === id ? 'bg-fpv-600 text-white border-fpv-600' : 'bg-white text-stone-600 border-stone-200'}`}>
      <Icon size={13} /> {rot}
      {badge != null && badge > 0 && <span className={`text-[10px] rounded-full px-1.5 ${sub === id ? 'bg-white text-fpv-700' : 'bg-red-600 text-white'}`}>{badge}</span>}
    </button>
  );

  // v70: régua unica da busca (acento + letra dobrada); nº por INÍCIO
  // igual à aba O.S. — normalizada 1x fora do filtro (celular fraco)
  const bLN = buscaNorm(buscaLista);
  const buscaSoNum = /^\d+$/.test(buscaLista.trim());
  const ListaSaidas = ({ limite }: { limite: number }) => (
    <div className="space-y-1.5">
      {saidas.filter(s =>
        (mesFiltro === 'TODOS' || (s.data || '').slice(0, 7) === mesFiltro) && (
          !buscaLista ||
          buscaNorm(s.descricao).includes(bLN) ||
          buscaNorm(s.escola || '').includes(bLN) ||
          (buscaSoNum
            ? (s.os_ref || '').replace(/^O\.?S\.?\s*/i, '').startsWith(buscaLista.trim())
            : buscaNorm(s.os_ref || '').includes(bLN))
        )
      ).slice(0, limite).map(s => {
        const dev = ehDevolucao(s);
        const trav = travadaSaida(s);
        return (
          <div key={s.id} className={`flex items-center gap-2 border rounded-xl px-3 py-2 text-sm ${dev ? 'border-amber-200 bg-amber-50/60' : trav ? 'border-stone-100 bg-stone-50/60' : 'border-stone-100'}`}>
            <span className="text-[11px] text-stone-400 tabular-nums shrink-0">{s.data?.split('-').reverse().slice(0, 2).join('/')}</span>
            <span className="flex-1 min-w-0 truncate">
              {dev ? <b className="text-amber-700">↩ +{Math.abs(s.quantidade)} {s.unidade}</b> : <b>{s.quantidade} {s.unidade}</b>} {s.descricao}
              {dev && <span className="text-[10px] text-amber-700 font-bold"> · devolução</span>}
              {/kit emergencial/i.test(s.origem || '') && <span className="text-[10px] text-red-600 font-bold"> · 🚨 kit</span>}
              {s.recebido === false && <span className="text-[10px] text-amber-700 font-bold"> · aguardando ✓ {s.destinatario}</span>}
              {s.recebido === true && <span className="text-[10px] text-fpv-700 font-bold"> · recebido ✔</span>}
            </span>
            {s.os_ref
              ? <span className="text-[11px] font-bold text-fpv-700 bg-fpv-50 border border-fpv-100 rounded-full px-2 py-0.5 shrink-0">O.S. {s.os_ref}</span>
              : <span className="text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5 shrink-0">sem O.S.</span>}
            {trav ? (
              <span className="p-1 text-stone-300 shrink-0" title="Mês fechado — só a gestão altera">🔒</span>
            ) : (
              <>
                {s.recebido === false && (
                  <button onClick={() => confirmarRecebidoManual(s)} title="Confirmar recebimento (assinou no papel)"
                    className="p-1 text-stone-300 hover:text-fpv-600 shrink-0"><CheckCircle2 size={14} /></button>
                )}
                {!dev && <button onClick={() => devolver(s)} title="Devolução" className="p-1 text-stone-300 hover:text-amber-600 shrink-0"><Undo2 size={14} /></button>}
                <button onClick={() => editarSaida(s)} title="Corrigir lançamento (material / nº O.S. / data / qtd)" className="p-1 text-stone-300 hover:text-fpv-600 shrink-0"><Pencil size={14} /></button>
                {(s.os_ref || '').trim() !== '' && (
                  <button onClick={() => preencherServico(s)} title="Preencher o SERVIÇO REALIZADO na O.S. vinculada" className="p-1 text-stone-300 hover:text-fpv-600 shrink-0"><CheckCircle2 size={14} /></button>
                )}
                <button onClick={() => excluirSaida(s)} className="p-1 text-stone-300 hover:text-red-500 shrink-0"><Trash2 size={14} /></button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
        <SubBtn id="stats" icon={BarChart3} rot="Estatística" />
        <SubBtn id="saida" icon={PackageMinus} rot="Saída" />
        <SubBtn id="cadastro" icon={PackagePlus} rot="Cadastro" />
        <SubBtn id="estoque" icon={Boxes} rot="Estoque" />
        <SubBtn id="ferramentas" icon={Wrench} rot="Ferramentas" />
        <SubBtn id="andaime" icon={Construction} rot="Andaime" />
        <SubBtn id="solicitacoes" icon={Inbox} rot="Pedidos" badge={pedidosAbertos.length} />
      </div>

      {faltaSQL && (
        <div className="text-xs font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
          ⚠️ O banco ainda não tem as tabelas do Almox v2 — rode o <b>ALMOX-V2.sql</b> no SQL Editor. A Saída continua funcionando normal.
        </div>
      )}
      {msg && <div className="text-sm font-medium text-fpv-700 bg-fpv-50 border border-fpv-100 rounded-lg px-3 py-2">{msg}</div>}

      {/* datalist GLOBAL (REV002): catálogo + estoque + termos aprendidos,
          disponível em TODAS as funções do almoxarifado */}
      <datalist id="materiais">{VOCABULARIO.map(m => <option key={m} value={m} />)}</datalist>

      {/* ============ ESTATÍSTICA ============ */}
      {sub === 'stats' && (
        <>
          {emFalta.length > 0 && (
            <div className="text-xs font-bold text-white bg-red-600 rounded-xl px-3 py-2.5">
              🚨 EM FALTA (saldo zerado/negativo): {emFalta.slice(0, 6).map(i => i.descricao).join(' · ')}{emFalta.length > 6 ? ` e mais ${emFalta.length - 6}` : ''} — repor!
            </div>
          )}
          {/* v72: o saldo só passa a valer depois da contagem física */}
          {semContagem.length > 0 && (
            <div className="text-xs font-bold text-stone-600 bg-stone-100 border border-stone-200 rounded-xl px-3 py-2.5">
              📋 {semContagem.length} {semContagem.length === 1 ? 'item ainda sem contagem física' : 'itens ainda sem contagem física'} — entraram no catálogo pela saída do balcão. Enquanto a gestão não fizer a contagem no 🧮, eles mostram o quanto já saiu, não saldo.
            </div>
          )}
          <div className="grid grid-cols-4 gap-2">
            <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-3 text-center">
              <div className="text-2xl font-bold text-stone-900 tabular-nums">{saidasHoje.length}</div>
              <div className="text-[10px] font-bold uppercase text-stone-400">saídas hoje</div>
            </div>
            <div className={`rounded-2xl border shadow-sm p-3 text-center ${semOS.length > 0 ? 'bg-amber-50 border-amber-200' : 'bg-white border-stone-200'}`}>
              <div className={`text-2xl font-bold tabular-nums ${semOS.length > 0 ? 'text-amber-700' : 'text-stone-900'}`}>{semOS.length}</div>
              <div className={`text-[10px] font-bold uppercase ${semOS.length > 0 ? 'text-amber-600' : 'text-stone-400'}`}>sem O.S.</div>
              {/* v72: ref que não resolve contava como vinculada e sumia do radar */}
              {refOrfa.length > 0 && (
                <div className="text-[9px] font-bold text-red-600 mt-0.5 leading-tight">+{refOrfa.length} c/ nº inexistente</div>
              )}
            </div>
            <div className={`rounded-2xl border shadow-sm p-3 text-center ${pedidosAbertos.length > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-stone-200'}`}>
              <div className={`text-2xl font-bold tabular-nums ${pedidosAbertos.length > 0 ? 'text-red-700' : 'text-stone-900'}`}>{pedidosAbertos.length}</div>
              <div className={`text-[10px] font-bold uppercase ${pedidosAbertos.length > 0 ? 'text-red-600' : 'text-stone-400'}`}>pedidos abertos</div>
            </div>
            <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-3 text-center">
              <div className="text-2xl font-bold text-stone-900 tabular-nums">{saidas.filter(s => ehDevolucao(s) && s.data >= seteDias).length}</div>
              <div className="text-[10px] font-bold uppercase text-stone-400">devoluções 7d</div>
            </div>
          </div>

          {top10Acabando.length > 0 && (
            <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-4">
              <h3 className="font-bold text-stone-900 text-sm flex items-center gap-2 mb-2">
                <TrendingUp size={15} className="text-red-600" /> Top 10 perto de acabar (vs. mínimo)
              </h3>
              <div className="space-y-1">
                {top10Acabando.map(({ i, s }) => {
                  const nv = nivelDe(i);
                  return (
                    <div key={i.id} className="flex items-center gap-2 text-sm">
                      <span className="flex-1 min-w-0 truncate text-stone-700">{i.descricao}</span>
                      <b className="tabular-nums">{s} {i.unidade}</b>
                      <span className="text-[10px] text-stone-400">mín {(() => { const m = minimoDe(i); return m ? Math.round(m.min * 10) / 10 : ''; })()}</span>
                      {nv && <span className={`text-[10px] font-bold border rounded-full px-2 py-0.5 ${nv.cls}`}>{nv.rot}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {emergAbertas.length > 0 && (
            <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-4">
              <h3 className="font-bold text-stone-900 text-sm flex items-center gap-2 mb-2">
                <Siren size={15} className="text-red-600" /> Emergenciais em aberto ({emergAbertas.length}) — material pode ser pedido a qualquer hora
              </h3>
              <div className="space-y-1">
                {emergAbertas.slice(0, 8).map(o => (
                  <div key={o.id} className="flex items-center gap-2 text-sm">
                    <b className="w-12 shrink-0 tabular-nums">{refDaOS(o)}</b>
                    <span className="flex-1 min-w-0 truncate text-stone-700">{o.unidade}</span>
                    <span className="text-[10px] text-stone-400">{o.status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-5">
            <h3 className="font-bold text-stone-900 mb-3 text-sm">Últimas saídas</h3>
            <ListaSaidas limite={10} />
          </div>
        </>
      )}

      {/* ============ SAÍDA ============ */}
      {sub === 'saida' && (
        <>
          {/* v87 (pedido do João): a equipe de emergência já escreve o
              material usado dentro da O.S., mas isso não descia pro balcão —
              o histórico de saída ficava sem essas peças. Aqui aparecem as
              O.S. com material DECLARADO e SEM saída lançada; um toque
              preenche o formulário abaixo. Não lanço automático de
              propósito: quantidade e item precisam do olho do João, senão
              o estoque baixa errado. */}
          {declaradasSemSaida.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-3">
              <h3 className="font-bold text-amber-900 text-sm flex items-center gap-2">
                <PackageMinus size={16} /> Material que a equipe declarou e ainda não saiu do estoque
                <span className="font-medium text-amber-700">({declaradasSemSaida.length} O.S.)</span>
              </h3>
              <p className="text-[11px] text-amber-800 mt-1 mb-2">
                Toque na O.S. para preencher a saída com esse texto — confira item e quantidade antes de salvar.
              </p>
              <div className="space-y-1.5 max-h-72 overflow-y-auto">
                {declaradasSemSaida.slice(0, 25).map(o => (
                  <button key={o.id} type="button"
                    onClick={() => {
                      // v113: com a cesta cheia, trocar de O.S. aqui levaria os
                      // itens já empilhados para OUTRA escola sem ele perceber —
                      // é a mesma falha dos 48 materiais carimbados na unidade
                      // errada que a auditoria achou. Pergunta antes.
                      // conta também o que está DIGITADO: ele também seria gravado
                      const pend = cesta.length + ((saida.descricao || '').trim() ? 1 : 0);
                      if (pend > 0 && !confirm(
                        `Você tem ${pend} ${pend === 1 ? 'item' : 'itens'} para lançar` +
                        `${(saida.escola || '').trim() ? ` em ${saida.escola}` : ''}.\n\n` +
                        `OK = esses itens passam para a O.S. ${refDaOS(o)} (${o.unidade})\n` +
                        `Cancelar = volta e salva a retirada atual primeiro`
                      )) return;
                      setSaida(p => ({ ...p, os_ref: refDaOS(o), escola: o.unidade, obs: `declarado na O.S.: ${(o.materiais || '').trim()}` }));
                      setMsg(`Saída pré-preenchida pela O.S. ${refDaOS(o)} — digite o item e a quantidade.`);
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                    className="w-full text-left bg-white border border-amber-100 rounded-xl px-3 py-2">
                    <div className="text-[12px] font-bold text-stone-800">
                      O.S. {refDaOS(o)} · {o.unidade}
                      <span className="font-medium text-stone-400"> · {o.executor || 'sem executor'}</span>
                    </div>
                    <div className="text-[11px] text-stone-600">{(o.materiais || '').replace(/\s+/g, ' ').trim()}</div>
                  </button>
                ))}
                {declaradasSemSaida.length > 25 && (
                  <p className="text-[11px] text-amber-700">… e outras {declaradasSemSaida.length - 25}. As mais recentes vêm primeiro.</p>
                )}
              </div>
            </div>
          )}
          <form onSubmit={salvarSaida} className="bg-white rounded-2xl border border-stone-200 shadow-sm p-5 space-y-4">
            <h2 className="font-bold text-stone-900 flex items-center gap-2"><PackageMinus size={18} className="text-fpv-600" /> Saída de material / ferramenta</h2>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">Data</label>
                <input type="date" value={saida.data} onChange={e => setSaida(p => ({ ...p, data: e.target.value }))} className={inputCls} /></div>
              <div><label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">Origem</label>
                <select value={saida.origem} onChange={e => setSaida(p => ({ ...p, origem: e.target.value }))} className={inputCls}>
                  {ORIGENS.map(o => <option key={o}>{o}</option>)}
                </select></div>
            </div>
            <div><label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">Material (catálogo + aprendidos)</label>
              {/* v113: SEM required — com a cesta cheia o campo fica vazio de
                  propósito, e o required travava o botão Registrar saída.
                  A validação de "pelo menos um material" está no salvarSaida. */}
              <input ref={refMaterial} list="materiais" value={saida.descricao}
                onChange={e => setSaida(p => ({ ...p, descricao: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addNaCesta(); } }}
                placeholder="ex.: SIF… já completa SIFÃO" className={inputCls} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">Quantidade</label>
                <input type="number" step="0.01" min="0" value={saida.quantidade}
                  onChange={e => setSaida(p => ({ ...p, quantidade: parseFloat(e.target.value) || 0 }))}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addNaCesta(); } }}
                  className={inputCls} /></div>
              <div><label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">Unidade</label>
                <select value={saida.unidade} onChange={e => setSaida(p => ({ ...p, unidade: e.target.value }))} className={inputCls}>
                  {UNIDADES.map(u => <option key={u}>{u}</option>)}
                </select></div>
            </div>

            {/* ===== v113 (Renan 06/10): CESTA DE MATERIAIS =====
                Uma retirada no balcão quase nunca é de um item só. Antes o
                João tinha de salvar o formulário inteiro, ver a escola/O.S./
                retirante voltarem e digitar tudo de novo por material. Agora
                ele empilha os itens e salva UMA vez — o cabeçalho (data,
                origem, O.S., unidade, quem retirou, contrato, obs) é comum e
                cada item vira sua própria linha em saida_material. */}
            <button type="button" onClick={addNaCesta}
              className="w-full border-2 border-dashed border-fpv-300 text-fpv-700 font-bold py-2.5 rounded-xl text-sm flex items-center justify-center gap-2 hover:bg-fpv-50">
              <Plus size={16} /> Adicionar este item e lançar outro
            </button>

            {cesta.length > 0 && (
              <div className="bg-fpv-50/60 border border-fpv-200 rounded-xl p-3 space-y-1.5">
                {/* o destino fica VISÍVEL o tempo todo: se ele trocar a escola
                    ou a O.S. no meio da retirada, esta linha muda na cara dele */}
                <p className="text-[11px] font-bold uppercase text-fpv-800">
                  {cesta.length} {cesta.length === 1 ? 'item' : 'itens'} →{' '}
                  {(saida.escola || '').trim() || <span className="text-amber-700">SEM UNIDADE</span>}
                  {(saida.os_ref || '').trim() ? ` · O.S. ${saida.os_ref}` : ''}
                </p>
                {cesta.map((c, ix) => (
                  <div key={`${c.descricao}-${ix}`} className="flex items-center gap-2 bg-white rounded-lg border border-fpv-100 px-2.5 py-1.5">
                    <span className="flex-1 text-[13px] text-stone-800"><b>{c.quantidade} {c.unidade}</b> {c.descricao}</span>
                    <button type="button" onClick={() => setCesta(l => l.filter((_, i2) => i2 !== ix))}
                      className="text-red-500 shrink-0" title="tirar da lista"><X size={15} /></button>
                  </div>
                ))}
                <p className="text-[11px] text-fpv-800/80">
                  Todos vão com a mesma O.S., unidade, contrato e retirante. O que estiver escrito no campo acima também entra ao salvar.
                </p>
              </div>
            )}
            <div><label className="block text-[11px] font-bold uppercase text-stone-500 mb-1"><Link2 size={11} className="inline mr-1" />O.S. vinculada (o coração do cruzamento)</label>
              <input list="refs-os" value={saida.os_ref} onChange={e => escolheuOS(e.target.value)} placeholder="nº oficial, L/M-nº ou F-nn — escolher puxa a escola" className="w-full border-2 border-fpv-100 rounded-lg px-3 py-2.5 text-sm bg-fpv-50/40 outline-none focus:border-fpv-500" />
              {/* chave pelo índice: o rótulo NÃO é único — o nº 1218 existe
                  duas vezes no banco (cicatriz histórica, a mesma que o
                  import da fiscalização apontou), e usá-lo como key enchia
                  o console de aviso do React e escondia erro de verdade */}
              <datalist id="refs-os">{refsOS.map((r, ix) => <option key={`${r.ref}-${ix}`} value={r.ref}>{r.rotulo}</option>)}</datalist>
              {!(saida.os_ref || '').trim() && (
                <label className={`mt-2 flex items-center gap-2 text-xs font-bold px-3 py-2.5 rounded-xl cursor-pointer border ${gerarOS ? 'bg-red-600 text-white border-red-600' : 'bg-red-50 text-red-700 border-red-200'}`}>
                  <input type="checkbox" checked={gerarOS} onChange={e => setGerarOS(e.target.checked)} className="hidden" />
                  <Siren size={14} /> {gerarOS ? 'VAI GERAR a O.S. emergencial ao salvar (escola + quem retirou obrigatórios)' : 'Emergência SEM O.S.? Toque aqui — o sistema gera a O.S. e vincula'}
                </label>
              )}</div>
            <div className="grid grid-cols-2 gap-3">
              {/* v91: a lista agora tem as unidades de SAÚDE junto com as
                  escolas — o João atende os dois contratos no mesmo balcão e
                  antes tinha de digitar posto de saúde na mão (por isso só
                  4 saídas em 3.765 tinham destino da Saúde). */}
              <div><label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">Unidade de destino (escola ou saúde)</label>
                <input list="escolas-almox" value={saida.escola}
                  onChange={e => setSaida(p => ({ ...p, escola: e.target.value, contrato: contratoDaUnidade(e.target.value) }))}
                  className={inputCls} />
                <datalist id="escolas-almox">
                  {ESCOLAS.map(e2 => <option key={`e-${e2}`} value={e2} />)}
                  {UNIDADES_SAUDE.map(s => <option key={`s-${s}`} value={s} />)}
                </datalist></div>
              <div><label className={`block text-[11px] font-bold uppercase mb-1 ${(saida.destinatario || '').trim() ? 'text-stone-500' : 'text-amber-600'}`}>Quem retirou (confirma no login)</label>
                <input list="destinatarios" value={saida.destinatario || ''} onChange={e => setSaida(p => ({ ...p, destinatario: e.target.value }))} placeholder="quem levou? (rastro!)"
                  className={(saida.destinatario || '').trim() ? inputCls : 'w-full border-2 border-amber-300 rounded-lg px-3 py-2.5 text-sm bg-amber-50/40 outline-none focus:border-fpv-500'} />
                <datalist id="destinatarios">{DESTINATARIOS.map(d => <option key={d} value={d} />)}</datalist></div>
            </div>
            {/* v91: o contrato aparece SEMPRE, já resolvido pela unidade, e
                dá para trocar. Mostrar em vez de decidir escondido: se o
                João discordar, ele corrige na hora, e o consumo dos dois
                contratos nasce separado sem depender de memória. */}
            {(() => {
              const ct = (saida.contrato as string) || contratoDaUnidade(saida.escola || '');
              const ehSaude = ct === 'Saúde';
              return (
                <div>
                  <label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">Contrato (vem da unidade — toque para trocar)</label>
                  <div className="flex gap-2">
                    {(['Educação', 'Saúde'] as const).map(c => (
                      <button key={c} type="button" onClick={() => setSaida(p => ({ ...p, contrato: c }))}
                        className={`flex-1 text-sm font-bold py-2.5 rounded-xl border ${ct === c
                          ? (c === 'Saúde' ? 'bg-sky-600 text-white border-sky-600' : 'bg-fpv-500 text-white border-fpv-500')
                          : 'bg-white text-stone-500 border-stone-200'}`}>{c}</button>
                    ))}
                  </div>
                  {ehSaude && <p className="text-[11px] text-sky-700 mt-1">Baixa no contrato da Saúde — sai do mesmo estoque, mas é prestada em separado.</p>}
                </div>
              );
            })()}
            <div><label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">Observação (de onde veio, detalhe da origem…)</label>
              <input value={saida.obs || ''} onChange={e => setSaida(p => ({ ...p, obs: e.target.value }))} placeholder="ex.: comprado na Hidro Luz p/ emergência" className={inputCls} /></div>
            <button type="submit" disabled={salvando} className="w-full bg-fpv-500 hover:bg-fpv-600 text-white font-bold py-3.5 rounded-xl flex items-center justify-center gap-2 disabled:opacity-60">
              {salvando ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
              {(() => {
                // v113: o botão conta o que vai gravar (cesta + o que está digitado)
                const n = cesta.length + (((saida.descricao || '').trim() && saida.quantidade > 0) ? 1 : 0);
                return n > 1 ? `Registrar saída (${n} itens)` : 'Registrar saída';
              })()}
            </button>
          </form>

          <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-5">
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <h3 className="font-bold text-stone-900 text-sm flex-1">Histórico de saídas <span className="text-stone-400 font-medium">({saidas.length})</span></h3>
              <select value={mesFiltro} onChange={e => setMesFiltro(e.target.value)}
                className="text-xs border border-stone-200 rounded-lg bg-stone-50 px-2 py-1 outline-none focus:border-fpv-500">
                <option value="TODOS">Todos os meses</option>
                {mesesDisponiveis.map(m => <option key={m} value={m}>{m.split('-').reverse().join('/')}{m === mesVigente ? ' (vigente)' : ' 🔒'}</option>)}
              </select>
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-2 text-stone-400" />
                <input value={buscaLista} onChange={e => setBuscaLista(e.target.value)} placeholder="material, escola, O.S…" className="pl-7 pr-2 py-1 text-xs border border-stone-200 rounded-lg bg-stone-50 outline-none focus:border-fpv-500 w-40" />
              </div>
            </div>
            <ListaSaidas limite={mostrar} />
            {saidas.length > mostrar && !buscaLista && (
              <button onClick={() => setMostrar(m => m + 100)} className="w-full text-xs font-bold text-fpv-700 py-3">Carregar mais</button>
            )}
          </div>
        </>
      )}

      {/* ============ CADASTRO (item + entrada c/ NF) ============ */}
      {sub === 'cadastro' && (
        <>
          <form onSubmit={salvarItem} className="bg-white rounded-2xl border border-stone-200 shadow-sm p-5 space-y-3">
            <h2 className="font-bold text-stone-900 text-sm">
              {itemExistente ? 'Atualizar item já cadastrado' : 'Cadastro no estoque (com quantidade mínima)'}
            </h2>
            <input list="materiais" value={item.descricao} onChange={e => setItem(p => ({ ...p, descricao: e.target.value }))} placeholder="material ou ferramenta" className={inputCls} />
            {/* v91: aviso de item existente. O pedido do João era editar a
                quantidade total aqui — dá, mas só com os valores atuais na
                tela; senão salvar com o formulário em branco zera a contagem. */}
            {itemExistente && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 text-[12px] text-amber-900">
                <b>Este item já existe no catálogo.</b> Hoje está com contagem <b>{itemExistente.saldo_inicial} {itemExistente.unidade}</b>
                {itemExistente.qtd_minima > 0 && <> e mínimo {itemExistente.qtd_minima}</>} em <b>{itemExistente.categoria}</b>.
                <br />Salvar assim <b>substitui</b> esses valores pelos que estiverem no formulário.
                <button type="button" onClick={puxarExistente}
                  className="mt-1.5 block font-bold text-amber-900 underline">Carregar os valores atuais para eu corrigir</button>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <select value={item.categoria} onChange={e => setItem(p => ({ ...p, categoria: e.target.value }))} className={inputCls}>
                {CATEGORIAS.map(c => <option key={c}>{c}</option>)}
              </select>
              <select value={item.unidade} onChange={e => setItem(p => ({ ...p, unidade: e.target.value }))} className={inputCls}>
                {UNIDADES.map(u => <option key={u}>{u}</option>)}
              </select>
              <div><label className="block text-[10px] font-bold uppercase text-stone-400 mb-0.5">Qtd MÍNIMA (alerta)</label>
                <input type="number" step="0.01" min="0" value={item.qtd_minima} onChange={e => setItem(p => ({ ...p, qtd_minima: parseFloat(e.target.value) || 0 }))} className={inputCls} /></div>
              <div><label className="block text-[10px] font-bold uppercase text-stone-400 mb-0.5">Contagem ATUAL (saldo inicial)</label>
                <input type="number" step="0.01" min="0" value={item.saldo_inicial} onChange={e => setItem(p => ({ ...p, saldo_inicial: parseFloat(e.target.value) || 0 }))} className={inputCls} /></div>
            </div>
            <button type="submit" disabled={salvando}
              className={`w-full font-bold py-3 rounded-xl text-white ${itemExistente ? 'bg-amber-600 hover:bg-amber-700' : 'bg-fpv-500 hover:bg-fpv-600'}`}>
              {itemExistente ? 'Atualizar este item' : 'Salvar no catálogo'}
            </button>
          </form>

          <form onSubmit={salvarEntrada} className="bg-white rounded-2xl border border-stone-200 shadow-sm p-5 space-y-3">
            <h2 className="font-bold text-stone-900 text-sm">Entrada de material (compra) — com foto da NOTA</h2>
            <div className="grid grid-cols-2 gap-3">
              <input type="date" value={entrada.data} onChange={e => setEntrada(p => ({ ...p, data: e.target.value }))} className={inputCls} />
              <input value={entrada.origem} onChange={e => setEntrada(p => ({ ...p, origem: e.target.value }))} placeholder="origem/fornecedor" className={inputCls} />
            </div>
            <input list="materiais" value={entrada.descricao} onChange={e => setEntrada(p => ({ ...p, descricao: e.target.value }))} placeholder="material" className={inputCls} />
            <div className="grid grid-cols-2 gap-3">
              <input type="number" step="0.01" min="0" value={entrada.quantidade} onChange={e => setEntrada(p => ({ ...p, quantidade: parseFloat(e.target.value) || 0 }))} className={inputCls} />
              <select value={entrada.unidade} onChange={e => setEntrada(p => ({ ...p, unidade: e.target.value }))} className={inputCls}>
                {UNIDADES.map(u => <option key={u}>{u}</option>)}
              </select>
            </div>
            <input value={entrada.obs || ''} onChange={e => setEntrada(p => ({ ...p, obs: e.target.value }))} placeholder="observação / nº da NF" className={inputCls} />
            <label className="flex items-center gap-2 text-sm font-bold text-fpv-700 bg-fpv-50 border border-fpv-100 px-4 py-2.5 rounded-lg cursor-pointer w-fit">
              <Camera size={16} /> {nfFoto ? `🧾 ${nfFoto.name.slice(0, 18)}…` : 'Foto da nota fiscal'}
              <input type="file" accept="image/*" className="hidden" onChange={e => setNfFoto(e.target.files?.[0] || null)} />
            </label>
            <button type="submit" disabled={salvando} className="w-full bg-fpv-500 hover:bg-fpv-600 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2">
              {salvando ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Registrar entrada
            </button>
          </form>

          {/* ===== v90: ENTRADAS LANÇADAS — ver e corrigir =====
              Antes daqui a entrada era cega: entrava no saldo e sumia da
              tela. Erro de digitação ficava somando para sempre. */}
          <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-5">
            <button onClick={() => setVerEntradas(v => !v)} className="w-full flex items-center justify-between text-left">
              <h2 className="font-bold text-stone-900 text-sm">Entradas lançadas ({entradas.length})</h2>
              <span className="text-[11px] font-bold text-fpv-700">{verEntradas ? 'ocultar' : 'ver e corrigir'}</span>
            </button>
            {verEntradas && (
              <div className="mt-3 space-y-1.5">
                {entradas.length === 0 && <p className="text-sm text-stone-400 text-center py-4">Nenhuma entrada registrada ainda.</p>}
                {[...entradas]
                  .sort((a, b) => String(b.data).localeCompare(String(a.data)) || Number(b.id || 0) - Number(a.id || 0))
                  .slice(0, 40)
                  .map(en => {
                    const editando = entradaEdit?.id === en.id;
                    if (!editando) return (
                      <div key={en.id} className="flex items-center gap-2 text-sm border-b border-stone-50 py-1.5">
                        <span className="text-[10px] text-stone-400 tabular-nums shrink-0">{String(en.data).slice(8, 10)}/{String(en.data).slice(5, 7)}</span>
                        <span className="flex-1 min-w-0 truncate text-stone-700">{en.descricao}</span>
                        <b className="tabular-nums text-stone-900 shrink-0">{en.quantidade} {en.unidade}</b>
                        {en.nf_url && <a href={en.nf_url} target="_blank" rel="noreferrer" title="nota fiscal" className="shrink-0">🧾</a>}
                        <button onClick={() => setEntradaEdit({ ...en })} title="Corrigir esta entrada"
                          className="p-1 text-stone-300 hover:text-fpv-600 shrink-0"><Pencil size={13} /></button>
                      </div>
                    );
                    return (
                      <div key={en.id} className="border border-fpv-200 bg-fpv-50/40 rounded-xl p-3 space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <input type="date" value={entradaEdit!.data} onChange={e => setEntradaEdit(p => ({ ...p!, data: e.target.value }))} className={inputCls} />
                          <input value={entradaEdit!.origem} onChange={e => setEntradaEdit(p => ({ ...p!, origem: e.target.value }))} placeholder="origem/fornecedor" className={inputCls} />
                        </div>
                        <input list="materiais" value={entradaEdit!.descricao} onChange={e => setEntradaEdit(p => ({ ...p!, descricao: e.target.value }))} placeholder="material" className={inputCls} />
                        <div className="grid grid-cols-2 gap-2">
                          <input type="number" step="0.01" min="0" value={entradaEdit!.quantidade}
                            onChange={e => setEntradaEdit(p => ({ ...p!, quantidade: parseFloat(e.target.value) || 0 }))} className={inputCls} />
                          <select value={entradaEdit!.unidade} onChange={e => setEntradaEdit(p => ({ ...p!, unidade: e.target.value }))} className={inputCls}>
                            {UNIDADES.map(u => <option key={u}>{u}</option>)}
                          </select>
                        </div>
                        <input value={entradaEdit!.obs || ''} onChange={e => setEntradaEdit(p => ({ ...p!, obs: e.target.value }))} placeholder="observação / nº da NF" className={inputCls} />
                        <div className="flex gap-2">
                          <button onClick={salvarEdicaoEntrada} disabled={salvando}
                            className="flex-1 bg-fpv-500 hover:bg-fpv-600 text-white font-bold py-2.5 rounded-xl text-sm">Salvar correção</button>
                          <button onClick={() => setEntradaEdit(null)}
                            className="px-4 border border-stone-200 text-stone-600 font-bold py-2.5 rounded-xl text-sm">Cancelar</button>
                          <button onClick={() => apagarEntrada(en)} title="Apagar lançamento errado/de teste"
                            className="px-3 border border-red-200 text-red-600 font-bold py-2.5 rounded-xl"><Trash2 size={14} /></button>
                        </div>
                      </div>
                    );
                  })}
                {entradas.length > 40 && <p className="text-[11px] text-stone-400 text-center pt-1">mostrando as 40 mais recentes de {entradas.length}</p>}
              </div>
            )}
          </div>
        </>
      )}

      {/* ============ ESTOQUE ============ */}
      {sub === 'estoque' && (
        <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-5">
          <h2 className="font-bold text-stone-900 text-sm mb-3">Estoque ({itens.length} itens cadastrados)</h2>
          <div className="flex gap-1.5 flex-wrap mb-3">
            {['TODAS', ...CATEGORIAS].map(c => (
              <button key={c} onClick={() => setCatFiltro(c)}
                className={`text-[11px] font-bold px-2.5 py-1 rounded-full border ${catFiltro === c ? 'bg-stone-800 text-white border-stone-800' : 'bg-white text-stone-500 border-stone-200'}`}>{c}</button>
            ))}
          </div>
          {itens.length === 0 && <p className="text-sm text-stone-400 text-center py-6">Nenhum item cadastrado — comece pela aba Cadastro (contagem física + mínimo).</p>}
          <div className="space-y-1">
            {itens.filter(i => catFiltro === 'TODAS' || i.categoria === catFiltro).map(i => {
              const s = saldoDe(i); const nv = nivelDe(i);
              return (
                <div key={i.id} className="flex items-center gap-2 text-sm border-b border-stone-50 py-1.5">
                  <span className="flex-1 min-w-0 truncate text-stone-700">{i.descricao}</span>
                  <span className="text-[10px] text-stone-400">{i.categoria}</span>
                  {/* v72: sem contagem física o número não é saldo, é só o
                      consumo acumulado — mostrar como saldo enganava */}
                  {/* v97: com marco zero o saldo tem DATA. Mostrar desde
                      quando ele vale — sem isso o número fica sem sentido
                      para quem lembra do estoque de antes da contagem. */}
                  {temContagem(i)
                    ? <b className={`tabular-nums ${s <= 0 ? 'text-red-600' : 'text-stone-900'}`}
                         title={`Contado em ${new Date(i.contagem_em!).toLocaleDateString('pt-BR')}: ${i.saldo_inicial} ${i.unidade}. O que saiu ANTES dessa data não desconta.`}>
                        {s} {i.unidade}
                      </b>
                    : <span className="text-[10px] font-bold text-stone-500 bg-stone-100 border border-stone-200 rounded-full px-2 py-0.5 shrink-0" title="Nunca contado — sem contagem não há saldo. Toque no 🧮 para contar: o número passa a valer a partir de hoje e o que saiu antes não desconta.">📋 sem contagem</span>}
                  {i.qtd_minima > 0 && <span className="text-[10px] text-stone-400">mín {i.qtd_minima}</span>}
                  {nv && <span className={`text-[10px] font-bold border rounded-full px-2 py-0.5 ${nv.cls}`}>{nv.rot}</span>}
                  <button onClick={() => editarItem(i)} title="Editar descrição/categoria/unidade/mínimo"
                    className="p-1 text-stone-300 hover:text-fpv-600 shrink-0"><Pencil size={13} /></button>
                  {podeContagemItem(i) && (
                    <button onClick={() => ajustarContagem(i)} title="Ajustar CONTAGEM (gestão · João em ferramentas/EPI)"
                      className="text-[10px] font-bold text-fpv-700 bg-fpv-50 border border-fpv-100 rounded-full px-2 py-0.5 shrink-0">🧮</button>
                  )}
                  <button onClick={() => excluirItem(i)} title="Excluir item do catálogo"
                      className="p-1 text-stone-300 hover:text-red-500 shrink-0"><Trash2 size={13} /></button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ============ FERRAMENTAS ============ */}
      {sub === 'ferramentas' && (
        <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-5 space-y-3">
          <h2 className="font-bold text-stone-900 text-sm">Ferramentas — quem está com o quê, em qual obra</h2>
          <div className="flex gap-2">
            <input value={novaFerr.descricao} onChange={e => setNovaFerr(p => ({ ...p, descricao: e.target.value }))} placeholder="ex.: MARTELETE BOSCH" className={inputCls} />
            <input type="number" min="1" value={novaFerr.quantidade} onChange={e => setNovaFerr(p => ({ ...p, quantidade: parseFloat(e.target.value) || 1 }))} className="w-20 border border-stone-200 rounded-lg px-3 py-2.5 text-sm bg-stone-50 outline-none focus:border-fpv-500" />
            <button onClick={criarFerramenta} className="bg-fpv-500 hover:bg-fpv-600 text-white font-bold px-4 rounded-xl text-sm">＋</button>
          </div>
          {ferramentas.length === 0 && <p className="text-sm text-stone-400 text-center py-4">Nenhuma ferramenta cadastrada.</p>}
          {/* REV 001 do gestor: listagem POR RESPONSÁVEL (tópicos) */}
          {(() => {
            const linha = (f: Ferramenta) => {
              const osRef = (f.obs || '').replace(/^O\.S\.\s*/i, '').trim();
              const osVinc = osRef ? listaOS.find(o => refDaOS(o) === osRef) : undefined;
              const aberta = ferrAberta === f.id;
              return (
                <div key={f.id} className={`border rounded-xl px-3 py-2 text-sm ${f.status === 'EM CAMPO' ? 'border-amber-200 bg-amber-50/50' : 'border-stone-100'}`}>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => setFerrAberta(aberta ? null : (f.id ?? null))} className="flex-1 min-w-0 text-left truncate">
                      <b>{f.quantidade > 1 ? f.quantidade + '× ' : ''}{f.descricao}</b>
                      {f.status === 'EM CAMPO' && (
                        osRef
                          ? <span className="text-[11px] font-bold text-fpv-700"> · O.S. {osRef}</span>
                          : <span className="text-[11px] font-bold text-amber-700"> · SEM O.S. vinculada</span>
                      )}
                      <span className="text-[10px] text-stone-400"> {aberta ? '▲' : '▼'}</span>
                    </button>
                    <button onClick={() => editarFerr(f)} title="Corrigir modelo/quantidade (e vínculo, se em campo)"
                      className="p-1 text-stone-300 hover:text-fpv-600 shrink-0"><Pencil size={13} /></button>
                    <button onClick={() => excluirFerr(f)} title="Apagar cadastro errado"
                      className="p-1 text-stone-300 hover:text-red-500 shrink-0"><Trash2 size={13} /></button>
                    {f.status === 'ESTOQUE'
                      ? <button onClick={() => entregarFerr(f)} className="text-[11px] font-bold text-fpv-700 bg-fpv-50 border border-fpv-100 rounded-full px-3 py-1 shrink-0">entregar →</button>
                      : <button onClick={() => receberFerr(f)} className="text-[11px] font-bold text-amber-800 bg-amber-100 border border-amber-200 rounded-full px-3 py-1 shrink-0">← voltou</button>}
                  </div>
                  {/* a FICHA: onde a ferramenta foi parar (pedido Renan 06/07) */}
                  {aberta && (
                    <div className="mt-1.5 pt-1.5 border-t border-amber-100 text-[11px] text-stone-600 space-y-0.5">
                      {f.status === 'EM CAMPO' ? (
                        <>
                          <p>👷 Com: <b>{f.com_quem || '—'}</b></p>
                          <p>📍 Obra: <b>{f.obra || '— (toque no lápis p/ preencher)'}</b></p>
                          <p>🔗 O.S.: <b className={osRef ? 'text-fpv-700' : 'text-amber-700'}>{osRef || 'SEM VÍNCULO (toque no lápis)'}</b>{osVinc ? <span className="text-stone-500"> — {osVinc.unidade} · {osVinc.status}</span> : ''}</p>
                          <p>📅 Em campo desde: {f.desde ? f.desde.split('-').reverse().join('/') : '—'}</p>
                        </>
                      ) : (
                        <p>📦 No estoque do almoxarifado — disponível, sem vínculo com O.S.</p>
                      )}
                    </div>
                  )}
                </div>
              );
            };
            const emCampo = ferramentas.filter(f => f.status === 'EM CAMPO');
            const noEstoque = ferramentas.filter(f => f.status !== 'EM CAMPO');
            // PLACAR DE SALDO (pedido João 17/08): a tela listava mas não SOMAVA —
            // "saldo não constou". Soma por UNIDADE (quantidade), não por cadastro:
            // carrinho de mão 4x conta 4. +7 dias em campo = cobrar devolução.
            const unid = (fs: Ferramenta[]) => fs.reduce((t, f) => t + Number(f.quantidade || 1), 0);
            // T12:00 evita o off-by-one de fuso ao parsear data pura (padrão hojeLocal)
            const fora7 = emCampo.filter(f => f.desde && (Date.now() - new Date(f.desde + 'T12:00:00').getTime()) / 86400000 >= 7);
            // SALDO UNITÁRIO POR FERRAMENTA (pedido Renan 17/08): o João numera os
            // itens ("SERRA MÁRMORE 01/02/03") — aqui a numeração final vira uma
            // FAMÍLIA só, com o saldo ao lado: quantas no estoque / total / em campo.
            // O sufixo removido é apenas "número (+1 letra)" no FIM: "MARTELETE 5KG"
            // e "ESCADA 7 DEGRAUS" não são tocados.
            const familia = (d: string) => d.trim().toUpperCase().replace(/\s+\d+\s*[A-ZÀ-Ü]?$/, '').replace(/\s{2,}/g, ' ').trim() || d.trim().toUpperCase();
            const familias: Record<string, { total: number; campo: number }> = {};
            for (const f of ferramentas) {
              const k = familia(f.descricao);
              const q = Number(f.quantidade || 1);
              (familias[k] = familias[k] || { total: 0, campo: 0 }).total += q;
              if (f.status === 'EM CAMPO') familias[k].campo += q;
            }
            const grupos: Record<string, Ferramenta[]> = {};
            for (const f of emCampo) { const k = (f.com_quem || 'Sem responsável').trim(); (grupos[k] = grupos[k] || []).push(f); }
            return (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="bg-stone-50 border border-stone-200 rounded-xl py-2">
                    <div className="text-lg font-bold text-stone-800">{unid(ferramentas)}</div>
                    <div className="text-[10px] text-stone-500 font-medium">UNIDADES NO TOTAL</div>
                  </div>
                  <div className="bg-amber-50 border border-amber-200 rounded-xl py-2">
                    <div className="text-lg font-bold text-amber-800">{unid(emCampo)}</div>
                    <div className="text-[10px] text-amber-700 font-medium">EM CAMPO</div>
                  </div>
                  <div className="bg-fpv-50 border border-fpv-100 rounded-xl py-2">
                    <div className="text-lg font-bold text-fpv-700">{unid(noEstoque)}</div>
                    <div className="text-[10px] text-fpv-700 font-medium">NO ESTOQUE</div>
                  </div>
                </div>
                {fora7.length > 0 && (
                  <p className="text-[11px] font-bold text-red-700 bg-red-50 border border-red-100 rounded-xl px-3 py-2">
                    ⏰ {fora7.length} ferramenta(s) em campo há 7+ dias — cobrar devolução
                  </p>
                )}
                {/* saldo de cada ferramenta ao lado do nome — rolagem rápida do João */}
                {Object.keys(familias).length > 0 && (
                  <div>
                    <div className="text-xs font-bold text-stone-500 mb-1.5">📊 Saldo por ferramenta</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                      {Object.entries(familias).sort((a, b) => a[0].localeCompare(b[0])).map(([nome, s]) => (
                        <div key={nome} className="flex items-center justify-between gap-2 border border-stone-100 rounded-lg px-2.5 py-1 text-[12px]">
                          <span className="truncate font-medium text-stone-700">{nome}</span>
                          <span className={`shrink-0 font-bold ${s.total - s.campo === 0 ? 'text-amber-700' : 'text-fpv-700'}`}>
                            {s.total - s.campo}/{s.total} no estoque{s.campo > 0 ? ` · ${s.campo} em campo` : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {Object.entries(grupos).sort((a, b) => a[0].localeCompare(b[0])).map(([quem, fs]) => (
                  <div key={quem}>
                    <div className="text-xs font-bold text-amber-800 mb-1.5">🧰 {quem} <span className="font-medium text-amber-600">({fs.reduce((t, f) => t + Number(f.quantidade || 1), 0)} item(ns) em campo)</span></div>
                    <div className="space-y-1.5">{fs.map(linha)}</div>
                  </div>
                ))}
                {noEstoque.length > 0 && (
                  <div>
                    <div className="text-xs font-bold text-stone-500 mb-1.5">📦 No estoque ({unid(noEstoque)} unid · {noEstoque.length} cadastros)</div>
                    <div className="space-y-1.5">{noEstoque.map(linha)}</div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* ============ ANDAIME (patrimônio fora do contrato) ============ */}
      {sub === 'andaime' && (
        <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-5 space-y-3">
          <h2 className="font-bold text-stone-900 text-sm">Andaime — patrimônio próprio <span className="text-stone-400 font-medium">(fora do contrato, não entra na medição)</span></h2>
          {faltaAndaime && (
            <p className="text-[12px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              ⚠️ Módulo novo: peça ao Renan/Nicolas para rodar o <b>ANDAIME.sql</b> no SQL Editor do Supabase — a aba liga sozinha depois.
            </p>
          )}
          <div className="flex gap-2">
            <input value={novoAnd.descricao} onChange={e => setNovoAnd(p => ({ ...p, descricao: e.target.value }))} placeholder="ex.: PAINEL 1,00 X 1,00" className={inputCls} />
            <input type="number" min="1" value={novoAnd.quantidade} onChange={e => setNovoAnd(p => ({ ...p, quantidade: parseFloat(e.target.value) || 1 }))} className="w-20 border border-stone-200 rounded-lg px-3 py-2.5 text-sm bg-stone-50 outline-none focus:border-fpv-500" />
            <button onClick={criarAndaime} className="bg-fpv-500 hover:bg-fpv-600 text-white font-bold px-4 rounded-xl text-sm">＋</button>
          </div>
          {!faltaAndaime && andItens.length === 0 && <p className="text-sm text-stone-400 text-center py-4">Nenhuma peça cadastrada — comece pelo ＋ (descrição + quantidade total).</p>}
          <div className="space-y-1.5">
            {andItens.map(i => {
              const movs = andMovs.filter(m => m.item_id === i.id);
              const fora = movs.reduce((t, m) => t + Number(m.quantidade || 0), 0);
              const disp = Number(i.quantidade_total || 0) - fora;
              const aberta = andAberto === i.id;
              return (
                <div key={i.id} className={`border rounded-xl px-3 py-2 text-sm ${fora > 0 ? 'border-amber-200 bg-amber-50/50' : 'border-stone-100'}`}>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => setAndAberto(aberta ? null : (i.id ?? null))} className="flex-1 min-w-0 text-left truncate">
                      <b>{i.descricao}</b>
                      <span className={`text-[11px] font-bold ${disp === 0 ? 'text-amber-700' : 'text-fpv-700'}`}> · {disp}/{i.quantidade_total} no pátio{fora > 0 ? ` · ${fora} em obra` : ''}</span>
                      <span className="text-[10px] text-stone-400"> {aberta ? '▲' : '▼'}</span>
                    </button>
                    <button onClick={() => editarAndaime(i)} title="Corrigir descrição/quantidade total" className="p-1 text-stone-300 hover:text-fpv-600 shrink-0"><Pencil size={13} /></button>
                    <button onClick={() => excluirAndaime(i)} title="Apagar cadastro errado" className="p-1 text-stone-300 hover:text-red-500 shrink-0"><Trash2 size={13} /></button>
                    <button onClick={() => enviarAndaime(i)} className="text-[11px] font-bold text-fpv-700 bg-fpv-50 border border-fpv-100 rounded-full px-3 py-1 shrink-0">enviar →</button>
                  </div>
                  {aberta && (
                    <div className="mt-1.5 pt-1.5 border-t border-amber-100 text-[11px] text-stone-600 space-y-1">
                      {movs.length === 0 && <p>📦 Tudo no pátio — nenhum movimento em aberto.</p>}
                      {movs.map(m => (
                        <div key={m.id} className="flex items-center gap-2">
                          <span className="flex-1">🏗 {m.quantidade}× em <b>{m.obra || '?'}</b> · {m.com_quem || 'sem responsável'} · desde {m.saida ? m.saida.split('-').reverse().join('/') : '—'}</span>
                          <button onClick={() => voltouAndaime(m, i)} className="text-[11px] font-bold text-amber-800 bg-amber-100 border border-amber-200 rounded-full px-3 py-1 shrink-0">← voltou</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ============ SOLICITAÇÕES ============ */}
      {sub === 'solicitacoes' && (
        <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-5">
          <h2 className="font-bold text-stone-900 text-sm mb-3">Pedidos das equipes <span className="text-stone-400 font-medium">({solicitacoes.length})</span></h2>
          {solicitacoes.length === 0 && <p className="text-sm text-stone-400 text-center py-6">Nenhum pedido ainda — as equipes pedem pelo Painel delas.</p>}
          <div className="space-y-2">
            {solicitacoes.map(q => (
              <div key={q.id} className={`border rounded-xl p-3 ${q.status === 'PEDIDO' ? 'border-red-200 bg-red-50/40' : q.status === 'SEPARADO' ? 'border-amber-200 bg-amber-50/40' : 'border-stone-100'}`}>
                <div className="flex items-center gap-2 mb-1.5">
                  <b className="text-sm text-stone-900">{q.solicitante}</b>
                  {q.os_ref && <span className="text-[11px] font-bold text-fpv-700 bg-fpv-50 border border-fpv-100 rounded-full px-2 py-0.5">O.S. {(q.os_ref || '').replace(/^O\.?S\.?\s*/i, '')}</span>}
                  <span className="text-[11px] text-stone-400 flex-1">{q.data?.split('-').reverse().slice(0, 2).join('/')}</span>
                  <button onClick={() => editarPedido(q)} title="Corrigir os itens do pedido" className="p-1 text-stone-300 hover:text-fpv-600"><Pencil size={13} /></button>
                  <span className={`text-[10px] font-bold rounded-full px-2 py-0.5 ${q.status === 'PEDIDO' ? 'bg-red-600 text-white' : q.status === 'SEPARADO' ? 'bg-amber-500 text-white' : 'bg-fpv-600 text-white'}`}>{q.status}</span>
                </div>
                {/* itens completos (texto longo NÃO trunca mais — Renan 12/07);
                    quebra por linha, vírgula ou ; casa com a geração de saída */}
                <div className="space-y-0.5">
                  {q.itens.split(/[\n,;]+/).map(l => l.trim()).filter(Boolean).map((l, i) => {
                    const c = checaLinha(l);
                    return (
                      <div key={i} className="flex items-start gap-2 text-sm">
                        <span className="flex-1 min-w-0 break-words text-stone-700">{l}</span>
                        <span className={`text-[10px] font-bold shrink-0 ${c.ok === true ? 'text-fpv-700' : c.ok === false ? 'text-red-600' : 'text-stone-400'}`}>
                          {c.ok === true ? '✔ ' : c.ok === false ? '✗ ' : '? '}{c.txt}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {q.status === 'PEDIDO' && (
                  <div className="mt-2 space-y-1.5">
                    <button onClick={() => gerarSaidasDoPedido(q)} disabled={salvando}
                      className="w-full text-xs font-black text-white bg-fpv-600 hover:bg-fpv-700 disabled:bg-stone-300 rounded-lg py-2.5 flex items-center justify-center gap-1.5">
                      <PackageMinus size={14} /> Gerar saídas deste pedido (dá baixa + vincula O.S.)
                    </button>
                    <button onClick={() => marcarSeparado(q)} className="w-full text-[11px] font-bold text-stone-500 underline py-1">
                      só marcar separado (material entregue por fora)
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default AlmoxOS;
