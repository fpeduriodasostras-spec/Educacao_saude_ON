import React, { useMemo, useState, useRef } from 'react';
import { Pencil, Trash2, Siren, Search, CheckCircle2, Hash, Lock, ChevronDown, ChevronUp, Share2, Loader2 } from 'lucide-react';
import { OSCampo, refDaOS, MED_OPTIONS, buscaNorm } from '../types';
import { medDoMes, hojeLocal, DESIGNADOS } from '../config';
import { osService } from '../services/osService';
import { compartilharOS, prepararFotos, enviarOS, legendaOS, motivoDoUltimoErro } from '../services/compartilhar';
import { supabase } from '../services/supabaseClient';

interface Props {
  lista: OSCampo[];
  aoEditar: (os: OSCampo) => void;
  aoMudar: () => void;
  filtroMinhas?: (os: OSCampo) => boolean; // o que é "meu": executor (encarregado) ou fiscal da zona (equipe)
  rotuloMinhas?: string;
  restrito?: boolean;   // campo vê SÓ as suas (decisão Renan 05/07) — sem "Todas"
  podeExcluir?: boolean; // AUDITORIA: excluir O.S. (dado de medição!) só gestão
  podePriorizar?: boolean; // RV000: prioridade operacional definida por Nicolas/Renan
}

// filtro de status pedido pelo Renan: pendente · executando ·
// pendente assinatura · concluídas (rótulo ≠ valor do banco)
const FILTROS_STATUS: { rotulo: string; casa: (os: OSCampo) => boolean }[] = [
  { rotulo: 'Todas', casa: () => true },
  { rotulo: 'Pendente', casa: os => os.status === 'Pendente' || os.status === 'Material' },
  { rotulo: 'Executando', casa: os => os.status === 'Executando' },
  { rotulo: 'Pend. assinatura', casa: os => os.status === 'Assinatura' },
  // 'Avaliando' saiu dos chips (Renan 08/07) — o status continua existindo
  // no formulário/banco; aqui só poluía com (0)
  { rotulo: 'Concluídas', casa: os => os.status === 'Concluído' },
];

const pillCor = (status: string) => {
  if (status === 'Concluído') return 'bg-fpv-50 text-fpv-700 border-fpv-100';
  if (status === 'Assinatura') return 'bg-amber-50 text-amber-700 border-amber-200';
  if (status === 'Avaliando') return 'bg-indigo-50 text-indigo-700 border-indigo-200';
  if (status === 'Cancelada') return 'bg-stone-100 text-stone-500 border-stone-200';
  return 'bg-orange-50 text-orange-700 border-orange-200';
};

const diasDesde = (iso?: string | null): number | null => {
  if (!iso) return null;
  const d = new Date(iso.slice(0, 10) + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
};

// alerta de prazo — hoje derivado da entrada + emergencial (48h);
// quando o prazo do e-mail do fiscal entrar no banco, é só trocar aqui
const alertaPrazo = (os: OSCampo) => {
  if (['Concluído', 'Cancelada'].includes(os.status)) return null;
  const d = diasDesde(os.entrada);
  if (d == null) return null;
  const limite = os.emergencial ? 2 : 15;
  const aviso = os.emergencial ? 1 : 7;
  if (d > limite) return { txt: `⏰ ${d}d — prazo estourado`, cls: 'bg-red-50 text-red-700 border-red-200' };
  if (d > aviso) return { txt: `⏳ ${d}d em aberto`, cls: 'bg-amber-50 text-amber-700 border-amber-200' };
  return null;
};

const ListaOS: React.FC<Props> = ({ lista, aoEditar, aoMudar, filtroMinhas, rotuloMinhas = 'Minhas O.S.', restrito = false, podeExcluir = false, podePriorizar = false }) => {
  const [busca, setBusca] = useState('');
  const [soMinhas, setSoMinhas] = useState(!!filtroMinhas);
  const [filtro, setFiltro] = useState('Todas');
  const [mostrar, setMostrar] = useState(100); // com a planilha importada são ~1.800 O.S.
  const [aberta, setAberta] = useState<number | null>(null); // card expandido (descrição completa)
  // DESPACHO EM 2 ETAPAS (Renan 08/07): os chips de P/designado agora são
  // SELEÇÃO local — só o botão "✔ Enviar" grava e manda pro painel.
  const [pend, setPend] = useState<Record<number, { p: number | null; exec: string }>>({});
  const [enviandoId, setEnviandoId] = useState<number | null>(null);

  const enviarDesignacao = async (os: OSCampo) => {
    const pd = pend[os.id ?? -1];
    if (!pd || enviandoId) return;
    setEnviandoId(os.id ?? null);
    await osService.salvar({ ...os, executor: pd.exec, prioridade: pd.p });
    setEnviandoId(null);
    setPend(prev => { const n = { ...prev }; delete n[os.id ?? -1]; return n; });
    aoMudar();
  };

  // TROCA DE MEDIÇÃO EM 1 TOQUE (v65, Renan 21/07: mutirão dos ~400 papéis
  // da MED 8 — e O.S. recusada pelo fiscal migra p/ a medição seguinte
  // sem abrir o formulário). Só gestão vê o seletor.
  const [mudandoMedId, setMudandoMedId] = useState<number | null>(null);
  // v105: anti duplo-toque no compartilhar DA LISTA (ver o comentário longo
  // em compartilhar(), abaixo). A trava de verdade é o ref, que muda na hora;
  // o estado existe só para a tela mostrar o giro e o progresso.
  const [compartilhandoId, setCompartilhandoId] = useState<number | null>(null);
  const [progShare, setProgShare] = useState('');
  const emShare = useRef(false);
  const [prontoId, setProntoId] = useState<number | null>(null);   // v108: qual O.S. já está com as fotos na mão
  const fotosProntas = useRef<File[] | null>(null);
  const mudarMedicao = async (os: OSCampo, med: string) => {
    if (med === (os.medicao || '')) return;
    setMudandoMedId(os.id ?? null);
    await osService.salvar({ ...os, medicao: med });
    setMudandoMedId(null);
    aoMudar();
  };

  // ============ MATCHMAKING FICTÍCIA ↔ OFICIAL (v63, Renan 10/07) ============
  // Regra dos 80% sem IA: fictícia aberta casa com O.S. oficial por MESMA
  // ESCOLA + entrada em ±7 dias (a mais próxima em data vence). A gestão
  // só arbitra com 1 toque — ninguém digita nada.
  const paresSugeridos = useMemo(() => {
    const mapa = new Map<number, OSCampo>();
    if (!podePriorizar) return mapa;
    const nrm = (s: string) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const difDias = (a: string, b: string) => Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
    const oficiais = lista.filter(o => o.numero != null && !o.excluida && !o.par_sugerido && o.entrada);
    const ficts = lista.filter(o => o.numero == null && !o.excluida && o.status !== 'Cancelada' && (o.fict_ref || o.numero_fict) && o.entrada);
    for (const f of ficts) {
      const tok = nrm(f.unidade).split(/[^a-z0-9]+/).filter(w => w.length >= 4);
      if (tok.length === 0) continue;
      let melhor: OSCampo | null = null; let melhorDist = 8;
      for (const o of oficiais) {
        const d = difDias(f.entrada!, o.entrada!);
        if (d > 7) continue;
        const alvo = nrm(o.unidade);
        const hits = tok.filter(t => alvo.includes(t)).length;
        if (hits < Math.ceil(tok.length * 0.5)) continue;
        if (d < melhorDist) { melhorDist = d; melhor = o; }
      }
      if (melhor && f.id != null) mapa.set(f.id, melhor);
    }
    return mapa;
  }, [lista, podePriorizar]);

  // v72: quando a fictícia vira oficial, o MATERIAL tem que ir junto.
  // Até aqui só a O.S. era atualizada: as saídas do almoxarifado seguiam
  // apontando p/ a ref antiga (L20, F-12...), que some da lista quando a
  // fictícia é cancelada — o material já consumido sumia do custo da O.S.
  // que vai para a medição (auditoria 24/07: 168 saídas órfãs vivas).
  // Também leva o pedido do balcão junto. Devolve quantas linhas migraram.
  const rechavearMaterial = async (refAntiga: string, refNova: string) => {
    const de = (refAntiga || '').trim();
    const para = (refNova || '').trim();
    if (!de || !para || de === para) return 0;
    const { data } = await supabase.from('saida_material')
      .update({ os_ref: para }).eq('os_ref', de).select('id');
    await supabase.from('solicitacao_material').update({ os_ref: para }).eq('os_ref', de);
    return (data || []).length;
  };

  // confirma o par: a OFICIAL herda a evidência da fictícia; a fictícia
  // vira marca "oficializada" (número eterno preservado, razão registra)
  const oficializar = async (f: OSCampo, o: OSCampo) => {
    if (!confirm(`Confirmar que a ${refDaOS(f)} é a O.S. oficial ${o.numero}?\n\nFotos, memória e status da ${refDaOS(f)} passam para a ${o.numero}; a ${refDaOS(f)} vira marca de oficializada (número preservado no razão).`)) return;
    const fotos = Array.from(new Set([...(o.foto_urls || []), ...(f.foto_urls || [])]));
    const upd: Partial<OSCampo> = {
      foto_urls: fotos,
      servico: (o.servico || '').trim() || (f.servico || ''),
      memoria_calculo: (o.memoria_calculo || '').trim() || (f.memoria_calculo || ''),
      materiais: [(o.materiais || '').trim(), (f.materiais || '').trim()].filter(Boolean).join('\n'),
      executor: (o.executor || '').trim() || (f.executor || ''),
      prioridade: o.prioridade ?? f.prioridade ?? null,
      par_sugerido: refDaOS(f),
      oficializada_em: new Date().toISOString(),
    };
    if (o.status === 'Pendente' && f.status !== 'Pendente') { upd.status = f.status; if (f.conclusao) upd.conclusao = f.conclusao; }
    await supabase.from('os_campo').update(upd).eq('id', o.id);
    await supabase.from('os_campo').update({ excluida: true, status: 'Cancelada', par_sugerido: String(o.numero) }).eq('id', f.id);
    const migrou = await rechavearMaterial(refDaOS(f), String(o.numero));
    if (migrou > 0) alert(`✅ Oficializada na ${o.numero}.\n\n${migrou} lançamento(s) de material do almoxarifado passaram da ${refDaOS(f)} para a ${o.numero} — o custo segue com a O.S. que vai para a medição.`);
    aoMudar();
  };

  // sem par ainda: texto pronto p/ cobrar o nº oficial do fiscal
  const copiarCobranca = (f: OSCampo) => {
    const txt = `Fiscal ${f.fiscal || ''}: favor emitir a O.S. para o atendimento ${refDaOS(f)} — ${f.unidade} — ${(f.solicitado || f.servico || '').trim()}${f.conclusao ? `, executado em ${f.conclusao}` : ''}.`;
    try { navigator.clipboard.writeText(txt); alert('📋 Texto copiado — cole no WhatsApp do fiscal.'); } catch { prompt('Copie o texto:', txt); }
  };

  // v78: compartilhar no grupo com a legenda padrão + as fotos da O.S.
  //
  // v105 — TRAVA CONTRA TOQUE REPETIDO E PROGRESSO NA TELA.
  // Este botão não tinha NENHUMA das duas coisas, e o da tela de salvar tem
  // desde a v87. Quem tocava aqui não via nada acontecer enquanto as fotos
  // baixavam (cada uma com até 20s de prazo), achava que não tinha pegado e
  // tocava de novo — e CADA TOQUE abre uma folha de compartilhamento.
  // É o mecanismo que transforma UMA O.S. em VÁRIAS mensagens no grupo: o
  // mesmo defeito que a v87 corrigiu no NovaOS e esqueceu aqui.
  // (caso do Neilson, 18/09: 6 fotos viraram 6 mensagens. O banco estava
  // certo — a N05 com as 6 fotos numa O.S. só. O estrago foi no envio.)
  // v108 — DOIS PASSOS NA LISTA TAMBÉM.
  // O 1º toque só BAIXA as fotos; o botão então vira "ENVIAR" e o 2º toque
  // abre a folha de compartilhamento sem esperar nada. O navegador só aceita
  // abrir essa folha logo depois do dedo sair da tela, e baixar as fotos
  // estourava esse prazo — ele recusava, a tela mandava colar à mão, o
  // operador colava e tocava de novo: o grupo recebia o cartão duas vezes.
  // Na lista não dá para baixar sozinho como o formulário faz (seriam
  // centenas de linhas), então o preparo é o primeiro toque.
  const compartilhar = async (os: OSCampo) => {
    // a trava é SÍNCRONA de propósito: setState do React chega tarde, e dois
    // toques no mesmo instante enxergariam o estado antigo e passariam os dois
    if (emShare.current) return;

    // 2º toque: já está preparada — ENVIA AGORA, sem nenhum await antes
    if (prontoId === os.id && fotosProntas.current) {
      const leg = legendaOS(os, medDoMes());
      emShare.current = true;
      try {
        avisar(await enviarOS(leg, fotosProntas.current, os.foto_urls?.length || 0), leg);
      } catch { avisar('erro', leg); }
      finally { emShare.current = false; fotosProntas.current = null; setProntoId(null); }
      return;
    }

    const n = os.foto_urls?.length || 0;
    // O.S. sem foto: nada a preparar, o toque já vale
    if (!n) {
      const leg = legendaOS(os, medDoMes());
      emShare.current = true;
      setCompartilhandoId(os.id ?? null);
      try { avisar(await compartilharOS(os, medDoMes()), leg); }
      catch { avisar('erro', leg); }
      finally { emShare.current = false; setCompartilhandoId(null); }
      return;
    }

    // 1º toque: prepara
    emShare.current = true;
    setCompartilhandoId(os.id ?? null);
    setProntoId(null);
    fotosProntas.current = null;
    setProgShare(`preparando ${n} fotos…`);
    try {
      const fs = await prepararFotos(os, (feitas, total) => setProgShare(`preparando fotos… ${feitas}/${total}`));
      fotosProntas.current = fs;
      setProntoId(os.id ?? null);
      setProgShare(fs.length ? `${fs.length} pronta(s) — toque em ENVIAR` : 'as fotos não baixaram — toque para mandar só a legenda');
    } catch {
      fotosProntas.current = [];
      setProntoId(os.id ?? null);
      setProgShare('as fotos não baixaram — toque para mandar só a legenda');
    } finally {
      emShare.current = false;
      setCompartilhandoId(null);
    }
  };

  const avisar = (r: string, legenda: string) => {
    setProgShare('');
    if (r === 'copiado') alert('📋 Legenda copiada — cole no grupo e anexe as fotos.');
    // v110: "ficou copiada" SÓ quando a cópia foi CONFIRMADA pelo navegador.
    // Quando a folha é recusada, o clipboard costuma ser negado junto — até a
    // v109 a falha era engolida e o operador colava no grupo o que estivesse
    // na área de transferência de antes (caso do Leony, 24/09). No 'erro'
    // seco, o prompt MOSTRA a legenda para copiar à mão: nada de colar vazio.
    // v111: o motivo técnico vai NA mensagem — o print do campo vira diagnóstico
    const motivo = motivoDoUltimoErro();
    const rodape = motivo ? `\n\n(motivo técnico p/ suporte: ${motivo})` : '';
    // v111: app aberto DENTRO do WhatsApp (link do fiscal) — share não existe lá
    if (r === 'navegador-embutido') alert(`⚠️ NADA foi enviado: o app está aberto no navegador de DENTRO do WhatsApp, e o envio de fotos NÃO funciona aqui.\n\nAbra o app pelo ÍCONE na tela inicial (ou toque em ⋮ → "Abrir no Chrome"), ache esta O.S. na LISTA e compartilhe de lá.${rodape}`);
    if (r === 'erro-copiado') alert(`❌ NADA foi enviado — o aparelho recusou o compartilhamento.\n\nA legenda ficou copiada: cole no grupo e mande as fotos pela galeria.${rodape}`);
    if (r === 'erro') {
      try {
        window.prompt(`❌ NADA foi enviado e a cópia automática falhou.${rodape}\n\nCopie a legenda abaixo (segure e selecione tudo) e cole no grupo — as fotos vão pela galeria:`, legenda);
      } catch {
        alert(`❌ NADA foi enviado — o aparelho recusou o compartilhamento e a legenda NÃO foi copiada. Tente de novo.${rodape}`);
      }
    }
    // v92: avisar quando a foto NÃO foi junto. Antes isso passava calado e o
    // grupo recebia o texto sem imagem nenhuma, sem ninguém perceber.
    // v103: agora cobre também o caso de as fotos não terem BAIXADO do
    // servidor — que antes caía num "✔ enviado" mentiroso.
    if (r === 'compartilhado-sem-fotos') alert('⚠️ Só o TEXTO foi compartilhado — NENHUMA foto chegou no grupo.\n\nOu as fotos não baixaram (sinal fraco), ou este aparelho não aceita anexo. Mande as fotos pela galeria do celular, no mesmo grupo.');
    if (r === 'compartilhado-parcial') alert('⚠️ Foi o cartão da O.S. e só PARTE das fotos.\n\nEste aparelho não aceitou o lote inteiro. Confira no grupo quantas chegaram e mande o resto pela galeria.');
  };

  // MEDIÇÃO FECHADA = intocável (spec do engenheiro): só a vigente edita.
  // Gestão ainda corrige (com aviso); campo não mexe.
  const medicaoFechada = (os: OSCampo) => !!(os.medicao || '').trim() && os.medicao !== medDoMes();
  const travada = (os: OSCampo) => medicaoFechada(os) && !podeExcluir;

  const minhas = filtroMinhas ? lista.filter(os => filtroMinhas(os) && os.status !== 'Cancelada') : [];
  const base = filtroMinhas && (soMinhas || restrito) ? minhas : lista;

  // fila de despacho do Nicolas (só gestão): abertas SEM designado —
  // depois do "✔ Enviar" a O.S. sai desta fila sozinha
  const FILTRO_A_DESIGNAR = {
    rotulo: 'A designar',
    casa: (os: OSCampo) => !os.excluida && !['Concluído', 'Cancelada'].includes(os.status)
      && !DESIGNADOS.some(d => d.executor === (os.executor || '').trim()),
  };
  const FILTRO_AGUARDANDO_N = {
    rotulo: 'Aguardando nº',
    casa: (os: OSCampo) => os.numero == null && !os.excluida && os.status !== 'Cancelada',
  };
  const filtros = podePriorizar ? [...FILTROS_STATUS, FILTRO_A_DESIGNAR, FILTRO_AGUARDANDO_N] : FILTROS_STATUS;
  const casaFiltro = filtros.find(f => f.rotulo === filtro)?.casa ?? (() => true);

  // BUSCA ABERTA (decisão Renan 10/07, caso real do Gilson com a O.S. no
  // papel que "não existia"): digitou na busca? A pesquisa varre TODAS as
  // O.S. do banco — veteranos trocam serviços e precisam achar qualquer
  // uma. A lista padrão continua PESSOAL e o painel não muda em nada.
  const buscando = busca.trim() !== '';
  const baseBusca = buscando ? lista : base;
  // v70: régua nova da busca — sem acento e com letra dobrada tolerada
  // (buscaNorm); número casa pelo INÍCIO (195 acha 195 e 1950-1959, mas
  // não a 1195). Campos varridos continuam os mesmos: ref, nº, escola,
  // executor — nenhuma informação foi tirada.
  const bDig = busca.trim();
  const soNumero = /^\d+$/.test(bDig);
  const bN = buscaNorm(busca.trim());
  const casaBusca = (os: OSCampo) => {
    if (!buscando) return true;
    if (soNumero) {
      return os.numero != null
        ? String(os.numero).startsWith(bDig)
        : buscaNorm(refDaOS(os)).includes(bDig); // fictícia procurada só por dígitos (ex.: 20 acha L20)
    }
    return (
      buscaNorm(refDaOS(os)).includes(bN) ||
      buscaNorm(os.unidade || '').includes(bN) ||
      buscaNorm(os.executor || '').includes(bN)
    );
  };
  const filtradas = baseBusca.filter(os => casaFiltro(os) && casaBusca(os));

  const abertas = minhas.filter(os => !['Concluído', 'Cancelada'].includes(os.status));
  const semFoto = abertas.filter(os => !(os.foto_urls?.length > 0)).length;
  const semMem = abertas.filter(os => !(os.memoria_calculo || '').trim()).length;

  const excluir = async (os: OSCampo) => {
    if (!os.id) return;
    if (!confirm(`Marcar a O.S. ${refDaOS(os)} — ${os.unidade} como EXCLUÍDA?\n\nO número continua ocupado na contagem e a exclusão fica registrada no livro-razão (quem/quando).`)) return;
    await osService.excluir(os.id);
    aoMudar();
  };

  // SÓ CONCLUI COMPLETA — ajuste Renan 08/07: memória e executor seguem
  // OBRIGATÓRIOS (é o dinheiro), mas a FOTO virou CONFIRMÁVEL para o
  // campo: as O.S. chegam assinadas e a foto já está no grupo do
  // WhatsApp — o campo dá baixa (antes era a Brendah) e a evidência é
  // anexada depois pela mineração dos grupos.
  const ocupadoRef = React.useRef(false);
  const concluir = async (os: OSCampo) => {
    if (ocupadoRef.current) return; // anti duplo-toque
    if (!podeExcluir) {
      const falta: string[] = [];
      if (!(os.memoria_calculo || '').trim()) falta.push('memória de cálculo');
      if (!(os.executor || '').trim()) falta.push('executor');
      if (falta.length > 0) {
        alert(`⛔ Para CONCLUIR falta: ${falta.join(' + ')}.\n\nToque no lápis, complete e conclua — sem as informações a O.S. não será concluída.`);
        return;
      }
      if (!(os.foto_urls?.length > 0) &&
          !confirm(`Concluir a ${refDaOS(os)} SEM FOTO no app?\n\nOK só se a foto já está no GRUPO do WhatsApp — a gestão confere e anexa depois.`)) {
        return;
      }
    }
    ocupadoRef.current = true;
    await osService.salvar({ ...os, status: 'Concluído', conclusao: os.conclusao || hojeLocal() });
    ocupadoRef.current = false;
    aoMudar();
  };

  // a O.S. oficial chega DEPOIS pelo e-mail do fiscal (acontece direto na
  // emergencial): 1 toque vincula o nº oficial — o F-nº fica guardado,
  // então o cruzamento de material feito no F-nº não se perde
  const vincularNumero = async (os: OSCampo) => {
    const resp = prompt(`Nº OFICIAL da O.S. que chegou por e-mail\n(hoje é a ${refDaOS(os)} — ${os.unidade}):`);
    if (resp == null) return;
    const n = parseInt(resp.replace(/\D/g, ''), 10);
    if (!n) return;
    const existe = await osService.numeroExiste(n);
    if (existe && existe.id !== os.id) {
      // REGRA NOVA (Renan 22/07, caso L20+L21→1330): nº JÁ EXISTE = o
      // fiscal emitiu UMA oficial cobrindo esta(s) emergência(s) → FUSÃO:
      // a oficial herda memória/fotos (append) e a fictícia vira marca
      // "oficializada → nº". Suporta VÁRIAS fictícias na mesma oficial.
      if (!confirm(`O nº ${n} JÁ EXISTE (${existe.unidade} · ${existe.status}).\n\nVINCULAR a ${refDaOS(os)} a ela? A oficial ${n} herda a memória e as fotos desta emergência, e a ${refDaOS(os)} vira registro "oficializada → ${n}".`)) return;
      const { data: alvoRows } = await supabase.from('os_campo')
        .select('id, servico, memoria_calculo, materiais, foto_urls, status, medicao, par_sugerido, executor')
        .eq('id', existe.id).limit(1);
      const alvo: any = alvoRows && alvoRows[0];
      if (!alvo) { alert('Não consegui carregar a oficial. Tente pela busca.'); return; }
      const marca = `Executado via emergência ${refDaOS(os)}${os.executor ? ` (${os.executor})` : ''}${os.conclusao ? ` em ${os.conclusao}` : ''}`;
      const memN = (alvo.memoria_calculo || '').trim();
      const upd: any = {
        memoria_calculo: memN ? `${memN}\n${marca}${(os.memoria_calculo || '').trim() ? ' — ' + (os.memoria_calculo || '').trim() : ''}` : `${marca}${(os.memoria_calculo || '').trim() ? ' — ' + (os.memoria_calculo || '').trim() : ''}`,
        foto_urls: Array.from(new Set([...(alvo.foto_urls || []), ...(os.foto_urls || [])])),
        par_sugerido: alvo.par_sugerido ? `${alvo.par_sugerido}+${refDaOS(os)}` : refDaOS(os),
        oficializada_em: new Date().toISOString(),
      };
      if (!(alvo.executor || '').trim() && (os.executor || '').trim()) upd.executor = os.executor;
      if ((os.materiais || '').trim()) upd.materiais = [(alvo.materiais || '').trim(), (os.materiais || '').trim()].filter(Boolean).join('\n');
      if (alvo.status === 'Pendente' && os.status === 'Concluído') { upd.status = 'Concluído'; if (os.conclusao) upd.conclusao = os.conclusao; }
      await supabase.from('os_campo').update(upd).eq('id', alvo.id);
      await supabase.from('os_campo').update({ excluida: true, status: 'Cancelada', par_sugerido: String(n) }).eq('id', os.id);
      const migrouF = await rechavearMaterial(refDaOS(os), String(n));
      if (migrouF > 0) alert(`✅ ${refDaOS(os)} vinculada à ${n}.\n\n${migrouF} lançamento(s) de material passaram para a ${n}.`);
      aoMudar();
      return;
    }
    // caminho simples: a fictícia GANHA o número. A ref muda de F-nº para
    // o nº (refDaOS prioriza numero), então o material lançado no F-nº
    // também precisa ser re-chaveado — senão fica apontando p/ uma ref
    // que nenhuma consulta do almoxarifado resolve mais.
    const refAntes = refDaOS(os);
    await osService.salvar({ ...os, numero: n });
    const migrouS = await rechavearMaterial(refAntes, String(n));
    if (migrouS > 0) alert(`✅ Agora é a O.S. ${n}.\n\n${migrouS} lançamento(s) de material passaram da ${refAntes} para a ${n}.`);
    aoMudar();
  };

  return (
    <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-5">
      <div className="flex items-center gap-3 mb-3">
        <h2 className="font-bold text-stone-900 flex-1">
          {filtroMinhas && (soMinhas || restrito)
            ? <>{rotuloMinhas} <span className="text-stone-400 font-medium">({minhas.length})</span></>
            : <>O.S. no banco central <span className="text-stone-400 font-medium">({lista.length})</span></>}
        </h2>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-2.5 text-stone-400" />
          <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="nº, escola, executor…"
            className="pl-8 pr-3 py-1.5 text-sm border border-stone-200 rounded-lg bg-stone-50 outline-none focus:border-fpv-500 w-48" />
        </div>
      </div>

      {filtroMinhas && !restrito && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <button onClick={() => setSoMinhas(true)}
            className={`rounded-full border px-3 py-1.5 text-xs font-bold ${soMinhas ? 'bg-fpv-600 text-white border-fpv-600' : 'bg-white text-stone-600 border-stone-200'}`}>
            Minhas ({minhas.length})
          </button>
          <button onClick={() => setSoMinhas(false)}
            className={`rounded-full border px-3 py-1.5 text-xs font-bold ${!soMinhas ? 'bg-fpv-600 text-white border-fpv-600' : 'bg-white text-stone-600 border-stone-200'}`}>
            Todas ({lista.length})
          </button>
        </div>
      )}

      {/* filtro por status — conta de cada balde já no botão */}
      <div className="flex items-center gap-1.5 mb-3 flex-wrap">
        {filtros.map(f => {
          const n = f.rotulo === 'Todas' ? base.length : base.filter(f.casa).length;
          return (
            <button key={f.rotulo} onClick={() => setFiltro(f.rotulo)}
              className={`rounded-full border px-3 py-1.5 text-[11px] font-bold ${filtro === f.rotulo ? 'bg-stone-800 text-white border-stone-800' : 'bg-white text-stone-500 border-stone-200'}`}>
              {f.rotulo} <span className="opacity-60">({n})</span>
            </button>
          );
        })}
      </div>

      {filtroMinhas && abertas.length > 0 && (
        <p className="text-[11px] text-stone-500 mb-3">
          {abertas.length} aberta{abertas.length !== 1 ? 's' : ''}
          {semFoto > 0 && <span className="text-amber-700 font-bold"> · {semFoto} sem foto</span>}
          {semMem > 0 && <span className="text-amber-700 font-bold"> · {semMem} sem memória</span>}
        </p>
      )}

      {buscando && restrito && (
        <p className="text-[11px] font-bold text-fpv-700 bg-fpv-50 border border-fpv-100 rounded-lg px-2.5 py-1.5 mb-2">
          🔎 Buscando em TODAS as O.S. do banco ({filtradas.length} encontradas) — apague a busca para voltar às suas.
        </p>
      )}
      {filtradas.length === 0 && (
        <p className="text-sm text-stone-400 text-center py-8">
          {filtro !== 'Todas' ? `Nenhuma O.S. em "${filtro}".`
            : filtroMinhas ? 'Nenhuma O.S. sua ainda. Registre pelo Formulário 💪'
            : 'Nenhuma O.S. ainda. Registre a primeira no Formulário 💪'}
        </p>
      )}

      <div className="space-y-2">
        {filtradas.slice(0, mostrar).map(os => {
          const alerta = alertaPrazo(os);
          const exp = aberta === os.id;
          return (
            <div key={os.id} className={`border rounded-xl p-3 transition-colors ${travada(os) ? 'border-stone-100 bg-stone-50/60' : 'border-stone-100 hover:border-fpv-100'}`}>
              <div className="flex items-start gap-3">
                <div className="w-14 shrink-0 text-center">
                  <div className="font-bold text-stone-900 tabular-nums">{refDaOS(os)}</div>
                  {os.emergencial && <Siren size={13} className="text-red-500 mx-auto mt-1" />}
                </div>
                <button type="button" onClick={() => setAberta(exp ? null : (os.id ?? null))} className="flex-1 min-w-0 text-left">
                  <div className="text-sm font-medium text-stone-800 truncate">{os.unidade}</div>
                  <div className="text-xs text-stone-500 truncate">{os.solicitado || os.servico || os.materiais || '—'}</div>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    {os.prioridade && <span className="text-[11px] font-black border rounded-full px-2 py-0.5 bg-red-600 text-white border-red-600">P{os.prioridade}</span>}
                    <span className={`text-[11px] font-bold border rounded-full px-2 py-0.5 ${pillCor(os.status)}`}>{os.status}{os.medicao ? ' · ' + os.medicao : ''}</span>
                    {os.excluida && <span className="text-[11px] font-bold border rounded-full px-2 py-0.5 bg-stone-800 text-white border-stone-800">🗑 EXCLUÍDA</span>}
                    {os.tipo && <span className={`text-[11px] font-bold border rounded-full px-2 py-0.5 ${os.tipo === 'Emergencial' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-stone-50 text-stone-500 border-stone-200'}`}>{os.tipo}</span>}
                    {medicaoFechada(os) && <span className="text-[11px] font-bold border rounded-full px-2 py-0.5 bg-stone-100 text-stone-500 border-stone-200">🔒 medição fechada</span>}
                    {alerta && <span className={`text-[11px] font-bold border rounded-full px-2 py-0.5 ${alerta.cls}`}>{alerta.txt}</span>}
                    {os.executor && <span className="text-[11px] text-stone-500">{os.executor}</span>}
                    {os.memoria_calculo && <span className="text-[11px] text-fpv-600 font-bold">📐 memória ok</span>}
                    {os.foto_urls?.length > 0 && <span className="text-[11px] text-stone-500">📷 {os.foto_urls.length}</span>}
                    {exp ? <ChevronUp size={13} className="text-stone-400" /> : <ChevronDown size={13} className="text-stone-300" />}
                  </div>
                </button>
                <div className="flex flex-col gap-1 shrink-0">
                  {travada(os) ? (
                    <span className="p-1.5 text-stone-300" title="Medição fechada — só a gestão altera"><Lock size={16} /></span>
                  ) : (
                    <>
                      {os.status !== 'Concluído' && (
                        <button onClick={() => concluir(os)} title="Marcar concluída"
                          className="p-1.5 text-fpv-600 hover:bg-fpv-50 rounded-lg"><CheckCircle2 size={16} /></button>
                      )}
                      {os.numero == null && (
                        <button onClick={() => vincularNumero(os)} title="Chegou a O.S. oficial por e-mail? Vincular nº"
                          className="p-1.5 text-amber-600 hover:bg-amber-50 rounded-lg"><Hash size={16} /></button>
                      )}
                      {/* v78: manda pro grupo com a legenda padrão + fotos */}
                      {/* v108: 1º toque prepara, 2º envia — o navegador só abre a
                          folha de compartilhamento dentro do toque, e baixar as
                          fotos estourava esse prazo */}
                      <button onClick={() => compartilhar(os)} disabled={compartilhandoId !== null}
                        title={compartilhandoId === os.id ? progShare : (prontoId === os.id ? 'Fotos prontas — toque para ENVIAR' : 'Compartilhar no grupo (legenda + fotos)')}
                        className={`p-1.5 rounded-lg disabled:opacity-40 ${prontoId === os.id ? 'text-white bg-fpv-600' : 'text-stone-400 hover:text-fpv-600 hover:bg-fpv-50'}`}>
                        {compartilhandoId === os.id ? <Loader2 size={16} className="animate-spin" /> : <Share2 size={16} />}
                      </button>
                      {(compartilhandoId === os.id || prontoId === os.id) && progShare && (
                        <span className="self-center text-[10px] font-bold text-fpv-700 whitespace-nowrap">{progShare}</span>
                      )}
                      <button onClick={() => aoEditar(os)} title="Editar"
                        className="p-1.5 text-stone-400 hover:text-fpv-600 hover:bg-stone-50 rounded-lg"><Pencil size={16} /></button>
                      {podeExcluir && (
                        <button onClick={() => excluir(os)} title="Excluir"
                          className="p-1.5 text-stone-300 hover:text-red-500 hover:bg-red-50 rounded-lg"><Trash2 size={16} /></button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* DESPACHO DA GESTÃO NO CARD RESUMIDO (Renan 08/07): chips
                  são SELEÇÃO — nada grava até tocar no "✔ Enviar" destacado.
                  Enviou → executor+P salvos → O.S. sai da fila "A designar"
                  e entra no quadro do designado. */}
              {podePriorizar && !travada(os) && (() => {
                const pd = pend[os.id ?? -1];
                const salvoP = os.prioridade ?? null;
                const salvoE = (os.executor || '').trim();
                const pAtual = pd ? pd.p : salvoP;
                const eAtual = pd ? pd.exec : salvoE;
                const mudou = !!pd; // pend só existe quando difere do salvo
                const jaDesignada = !pd && DESIGNADOS.some(d => d.executor === eAtual) && !!eAtual;
                // seleção que voltou a ser IGUAL ao salvo → limpa a pendência
                // (caso real 08/07: tirou e recolocou o mesmo nome e o card
                // ficava sem ENVIAR e sem selo — parecia travado)
                const aplica = (novoP: number | null, novoE: string) => setPend(prev => {
                  const n = { ...prev };
                  if (novoP === salvoP && novoE === salvoE) delete n[os.id ?? -1];
                  else n[os.id ?? -1] = { p: novoP, exec: novoE };
                  return n;
                });
                const marcaP = (p: number) => aplica(pAtual === p ? null : p, eAtual);
                const marcaE = (e: string) => { const novo = eAtual === e ? '' : e; aplica(pAtual ?? (novo ? 3 : null), novo); };
                return (
                  <div className="mt-2 ml-[4.25rem] flex items-center gap-1.5 flex-wrap">
                    {[1, 2, 3].map(p => (
                      <button key={p} onClick={() => marcaP(p)}
                        className={`text-[11px] font-bold border rounded-full px-2.5 py-0.5 ${pAtual === p ? 'bg-red-600 text-white border-red-600' : 'bg-white text-stone-500 border-stone-200'}`}>
                        P{p}
                      </button>
                    ))}
                    <span className="text-stone-200">·</span>
                    {DESIGNADOS.map(d => (
                      <button key={d.executor} onClick={() => marcaE(d.executor)}
                        className={`text-[11px] font-bold border rounded-full px-2.5 py-0.5 ${eAtual === d.executor ? 'bg-fpv-600 text-white border-fpv-600' : 'bg-white text-stone-500 border-stone-200'}`}>
                        {d.rotulo.replace('Carlos Alberto', 'C. Alberto').replace('Eq. ', '')}
                      </button>
                    ))}
                    {mudou && (
                      <>
                        <button onClick={() => enviarDesignacao(os)} disabled={enviandoId === os.id}
                          className="text-[11px] font-black rounded-full px-3.5 py-1 bg-fpv-600 text-white shadow-md disabled:opacity-50 animate-pulse">
                          {enviandoId === os.id ? 'Enviando…' : '✔ ENVIAR'}
                        </button>
                        <button onClick={() => setPend(prev => { const n = { ...prev }; delete n[os.id ?? -1]; return n; })}
                          className="text-[11px] font-bold text-stone-400 underline">
                          cancelar
                        </button>
                      </>
                    )}
                    {jaDesignada && (
                      <>
                        <span className="text-[11px] font-bold text-fpv-700 bg-fpv-50 border border-fpv-100 rounded-full px-2 py-0.5">✔ designada</span>
                        {(() => {
                          const d = DESIGNADOS.find(x => x.executor === (os.executor || '').trim());
                          if (!d || !d.zap) return null;
                          const msg = `${d.rotulo}: te passei a O.S. ${refDaOS(os)} — ${os.unidade}. ${os.solicitado || os.servico || ''}${os.prioridade ? ` (P${os.prioridade})` : ''} · https://fpvieira.vercel.app`;
                          return (
                            <a href={`https://wa.me/${d.zap}?text=${encodeURIComponent(msg)}`} target="_blank" rel="noreferrer"
                              className="text-[11px] font-bold border rounded-full px-2.5 py-0.5 bg-green-50 text-green-700 border-green-200">
                              📲 Avisar
                            </a>
                          );
                        })()}
                      </>
                    )}
                    <span className="text-stone-200">·</span>
                    <select value={os.medicao || ''} disabled={mudandoMedId === os.id}
                      onChange={e => mudarMedicao(os, e.target.value)}
                      title="Mover esta O.S. de medição"
                      className={`text-[11px] font-bold border rounded-full px-2 py-0.5 outline-none ${os.medicao ? 'bg-fpv-50 text-fpv-700 border-fpv-200' : 'bg-white text-stone-400 border-stone-200'}`}>
                      <option value="">MED —</option>
                      {(os.medicao && !MED_OPTIONS.includes(os.medicao) ? [...MED_OPTIONS.filter(m => m), os.medicao] : MED_OPTIONS.filter(m => m))
                        .map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                );
              })()}

              {/* MATCHMAKING (v63): fictícia com provável par oficial ganha o
                  chip de confirmação; sem par, o botão de cobrar o nº */}
              {podePriorizar && os.numero == null && !os.excluida && os.status !== 'Cancelada' && (() => {
                const par = paresSugeridos.get(os.id ?? -1);
                return (
                  <div className="mt-1.5 ml-[4.25rem] flex items-center gap-1.5 flex-wrap">
                    {par ? (
                      <>
                        <span className="text-[11px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-0.5">
                          🔗 provável par: O.S. {par.numero} · mesma escola · entrada {par.entrada || '—'}
                        </span>
                        <button onClick={() => oficializar(os, par)}
                          className="text-[11px] font-black rounded-full px-3 py-1 bg-fpv-600 text-white shadow">
                          ✔ confirmar par
                        </button>
                      </>
                    ) : (
                      <button onClick={() => copiarCobranca(os)}
                        className="text-[11px] font-bold text-stone-500 bg-white border border-stone-200 rounded-full px-2.5 py-0.5">
                        📋 copiar cobrança do nº p/ o fiscal
                      </button>
                    )}
                  </div>
                );
              })()}

              {/* descrição completa (spec do engenheiro: ver o texto da O.S.
                  do e-mail em qualquer status) — toque no card abre/fecha */}
              {exp && (
                <div className="mt-2 ml-[4.25rem] space-y-1.5 text-xs text-stone-600 border-t border-stone-100 pt-2">
                  {os.solicitado && <p><b className="text-stone-400 uppercase text-[10px]">Fiscal pediu (e-mail): </b>{os.solicitado}</p>}
                  {os.servico && <p><b className="text-stone-400 uppercase text-[10px]">Executado: </b>{os.servico}</p>}
                  {os.materiais && <p><b className="text-stone-400 uppercase text-[10px]">Materiais: </b>{os.materiais}</p>}
                  {os.memoria_calculo && <p><b className="text-stone-400 uppercase text-[10px]">Memória: </b>{os.memoria_calculo}</p>}
                  <p><b className="text-stone-400 uppercase text-[10px]">Fiscal: </b>{os.fiscal || '—'} · <b className="text-stone-400 uppercase text-[10px]">Entrada: </b>{os.entrada || '—'} · <b className="text-stone-400 uppercase text-[10px]">Conclusão: </b>{os.conclusao || '—'}</p>
                  {os.geo && (
                    <p><b className="text-stone-400 uppercase text-[10px]">Local do registro: </b>
                      <a href={`https://maps.google.com/?q=${os.geo.split(' ')[0]}`} target="_blank" rel="noreferrer" className="text-fpv-700 font-bold underline">📍 abrir no mapa</a>
                      <span className="text-stone-400"> ({os.geo})</span>
                    </p>
                  )}
                  {os.foto_urls?.length > 0 && (
                    <p className="flex gap-2 flex-wrap">
                      {os.foto_urls.map((u, i) => (
                        <a key={i} href={u} target="_blank" rel="noreferrer" className="text-fpv-700 font-bold underline">📷 foto {i + 1}</a>
                      ))}
                    </p>
                  )}
                  {!os.solicitado && !os.servico && !os.materiais && !os.memoria_calculo && (
                    <p className="text-stone-400">Sem descrição registrada ainda — toque no lápis para completar.</p>
                  )}
                  {/* comandos de prioridade/designação subiram pro card
                      RESUMIDO (pedido Renan 08/07) — aqui só a leitura */}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {filtradas.length > mostrar && (
        <button onClick={() => setMostrar(m => m + 200)}
          className="w-full text-xs font-bold text-fpv-700 py-3">
          Carregar mais ({filtradas.length - mostrar} restantes)
        </button>
      )}
    </div>
  );
};

export default ListaOS;
