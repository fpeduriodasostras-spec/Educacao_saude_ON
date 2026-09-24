import React, { useEffect, useRef, useState } from 'react';
import { Save, Mic, Camera, X, Loader2, Eraser, Siren, PackageMinus, Plus, Minus } from 'lucide-react';
import { OSCampo, STATUS_OPTIONS, FISCAL_OPTIONS, CLASSIF_OPTIONS, EXECUTOR_OPTIONS, MED_OPTIONS, TIPO_OPTIONS, refDaOS } from '../types';
import { ESCOLAS } from '../data/escolas';
import { UNIDADES_SAUDE, LOCAIS_SAUDE, fiscalDaUnidadeSaude, contratoDaUnidade } from '../data/unidadesSaude';
import { KIT_EMERGENCIAL } from '../data/materiais';
import { guiaMedida } from '../data/areas';
import { VOZ_ATIVA, GESTORES, EQUIPES, CORRETIVA, DOIS_CONTRATOS, medDoMes, hojeLocal } from '../config';
import { osService } from '../services/osService';
import { compartilharOS, prepararFotos, enviarOS, legendaOS, copiarLegenda, navegadorEmbutido, motivoDoUltimoErro } from '../services/compartilhar';
import { deepLinkPrefill, consomeDeepLink } from '../services/deepLink';

const normaliza = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '');

// Teto de fotos por O.S. (v85). Era 7 e vinha do ChatOS de julho; o campo
// bateu no limite registrando antes/depois de várias frentes na mesma O.S.
// Subiu pra 15 — o custo é upload no sinal da escola, não espaço no banco.
// Mudar aqui muda no formulário inteiro.
// v101 (pedido do Renan 18/09): era 15. Com a compressão da v99 cada foto
// pesa ~84 KB, então 30 fotos são ~2,5 MB — menos do que 15 fotos pesavam
// antes de comprimir.
const MAX_FOTOS = 30;

// defaults por login (spec Nicolas): equipe de emergência já entra com
// fiscal da zona + EMERGENCIAL ligado; encarregado corretivo já entra
// como executor — "responsável preenchido automaticamente com o login"
const vaziaPara = (usuario: string): OSCampo => {
  const equipe = EQUIPES[usuario];
  const corretiva = CORRETIVA[usuario];
  const executorLogado = corretiva?.executor ?? EXECUTOR_OPTIONS.find(e => normaliza(e) === normaliza(usuario));
  return {
    numero: null,
    emergencial: !!equipe,
    tipo: equipe ? 'Emergencial' : 'Corretiva',
    unidade: '',
    local: '',
    fiscal: equipe?.fiscal ?? 'Wellington',
    classificacao: equipe ? 'Emergencial' : 'Normal',
    entrada: hojeLocal(),
    conclusao: null,
    executor: executorLogado ?? '',
    status: 'Executando',
    medicao: '', solicitado: '', servico: '', materiais: '', memoria_calculo: '', foto_urls: []
  };
};

interface Props {
  editando: OSCampo | null;
  usuario: string;
  aoSalvar: () => void;
  aoCancelarEdicao: () => void;
}

const NovaOS: React.FC<Props> = ({ editando, usuario, aoSalvar, aoCancelarEdicao }) => {
  const equipe = EQUIPES[usuario];
  const corretiva = CORRETIVA[usuario];
  // prefixo da numeração automática: L/M (equipes) ou G/C (corretiva)
  const prefixoRef = equipe?.prefixo ?? corretiva?.prefixo;
  const ehGestor = GESTORES.includes(usuario);
  // v109: pedido do fiscal vindo pelo LINK do grupo (?os=...) — aplicado uma
  // única vez, no initializer (StrictMode-safe: o módulo lê a URL 1x e o
  // consumo no efeito abaixo é idempotente)
  const prefillLink = useRef<Partial<OSCampo> | null>(deepLinkPrefill());
  const [avisoLink, setAvisoLink] = useState('');
  const [os, setOs] = useState<OSCampo>(() =>
    prefillLink.current ? { ...vaziaPara(usuario), ...prefillLink.current } : vaziaPara(usuario));
  const [fotos, setFotos] = useState<File[]>([]);
  const [kit, setKit] = useState<Record<string, number>>({}); // descricao → qtd usada
  const [kitAberto, setKitAberto] = useState(false);
  const [baixaAuto, setBaixaAuto] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState('');
  // v78: O.S. recém-salva, p/ oferecer o compartilhamento no grupo
  const [ultimaSalva, setUltimaSalva] = useState<OSCampo | null>(null);
  const [msgShare, setMsgShare] = useState('');
  // v108: as fotos baixadas ANTES do toque. Enquanto for null, o botão ainda
  // faz o caminho antigo (baixa e envia na mesma ação).
  const fotosProntas = useRef<File[] | null>(null);
  const [fotosNoPonto, setFotosNoPonto] = useState(0);   // só para o rótulo do botão
  const [preparo, setPreparo] = useState<'nada' | 'baixando' | 'pronto'>('nada');
  // v86: o formulário é limpo logo após salvar, então guardo aqui se foi
  // EDIÇÃO — o texto do painel muda ("corrigiu… mandar a versão certa?")
  const [salvaFoiEdicao, setSalvaFoiEdicao] = useState(false);
  const [compartilhando, setCompartilhando] = useState(false); // v87: anti duplo-toque no share
  const emShare = useRef(false);   // v106: a trava de verdade — o estado chega tarde demais
  // v110: quando o aparelho recusa a folha E a cópia automática falha, a
  // legenda fica aqui esperando um TOQUE NOVO no botão "copiar legenda" —
  // toque novo = permissão nova do navegador, e a cópia sai de verdade.
  const [legendaPendente, setLegendaPendente] = useState<string | null>(null);
  // v87: contrato escolhido decide a lista de unidades e de locais
  const ehSaude = (os.contrato || '') === 'Saúde';
  const [ouvindo, setOuvindo] = useState(false);
  const recRef = useRef<any>(null);
  const fotoRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editando) {
      // NORMALIZA NULLS (crash real 10/07: O.S. inseridas pelo n8n vêm com
      // NULL onde o app grava '' — a 1839 abria em TELA CINZA no .trim())
      const t = (v: any) => (v == null ? '' : String(v));
      setOs({
        ...editando,
        unidade: t(editando.unidade), fiscal: t(editando.fiscal),
        classificacao: t(editando.classificacao), executor: t(editando.executor),
        status: t(editando.status) || 'Executando', medicao: t(editando.medicao),
        solicitado: t(editando.solicitado), servico: t(editando.servico),
        materiais: t(editando.materiais), memoria_calculo: t(editando.memoria_calculo),
        foto_urls: editando.foto_urls || [],
      });
      // evita carregar fotos/kit de um formulário anterior para a O.S. editada
      setFotos([]);
      setKit({});
      setKitAberto(false);
      setMsg('');
    }
  }, [editando]);

  // v109: consumo do deep link — limpa a query da barra (F5 não re-preenche)
  // e avisa NA HORA se um colega já registrou essa O.S. (antes o colaborador
  // só descobria no salvar, com uma mensagem que sugeria gerar fictícia).
  useEffect(() => {
    const p = prefillLink.current;
    if (!p) return;
    consomeDeepLink();
    (async () => {
      if (!p.numero) return;
      const existe = await osService.numeroExiste(Number(p.numero));
      if (existe) setAvisoLink(`⛔ A O.S. ${p.numero} JÁ FOI REGISTRADA (${existe.unidade} · ${existe.status}) — outro colega chegou primeiro. Ache-a na LISTA e complete pelo lápis. NÃO registre de novo.`);
      else setAvisoLink(`📥 O.S. ${p.numero} recebida do fiscal — confira os dados, registre a execução e mande pro grupo.`);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // RASCUNHO AUTOMÁTICO (Renan 09/07: celular do campo trava e perde a
  // digitação — caso do encarregado que prefere papel): cada tecla fica
  // guardada NO APARELHO; travou/fechou, ao reabrir aparece o botão
  // "Recuperar". Some sozinho ao salvar com sucesso ou descartar.
  const chaveRascunho = editando?.id ? `fpv_rascunho_${editando.id}` : 'fpv_rascunho_novo';
  const [rascunho, setRascunho] = useState<OSCampo | null>(null);
  useEffect(() => {
    // v109 (revisão): rascunho antigo CONTINUA sendo oferecido mesmo chegando
    // pelo link do fiscal — o banner fica por cima do formulário preenchido e
    // o colaborador decide. Suprimir aqui destruía digitação não salva (o
    // autosave sobrescreve o storage no 1º render; a recuperação vive no
    // estado `rascunho` deste mount).
    try {
      const raw = localStorage.getItem(chaveRascunho);
      if (!raw) { setRascunho(null); return; }
      const d = JSON.parse(raw);
      const temConteudo = d && d.os && (d.os.unidade || d.os.solicitado || d.os.servico || d.os.materiais || d.os.memoria_calculo);
      if (temConteudo && d.t && Date.now() - d.t < 24 * 3600 * 1000) setRascunho(d.os);
      else { localStorage.removeItem(chaveRascunho); setRascunho(null); }
    } catch { setRascunho(null); }
  }, [chaveRascunho]);
  useEffect(() => {
    try { localStorage.setItem(chaveRascunho, JSON.stringify({ os, t: Date.now() })); } catch { /* sem espaço no aparelho — segue sem rascunho */ }
  }, [os, chaveRascunho]);

  // v108 — BAIXA AS FOTOS ANTES DE ELE TOCAR.
  // O cartão "Mandar pro grupo?" aparece assim que a O.S. salva, e o operador
  // leva alguns segundos lendo. Aproveitamos esses segundos: quando ele tocar,
  // os arquivos já estão na memória e a folha de compartilhamento abre DENTRO
  // do toque — que é a única forma de o navegador aceitar abri-la.
  useEffect(() => {
    fotosProntas.current = null;
    setFotosNoPonto(0);
    setPreparo('nada');
    if (!ultimaSalva) return;
    const n = ultimaSalva.foto_urls?.length || 0;
    if (!n) return;                          // O.S. sem foto: nada a preparar
    setPreparo('baixando');
    let valeAinda = true;
    (async () => {
      const fs = await prepararFotos(ultimaSalva);
      if (!valeAinda) return;               // ele já fechou o cartão ou salvou outra
      fotosProntas.current = fs;            // pode vir vazio: o enviarOS avisa
      setFotosNoPonto(fs.length);
      setPreparo('pronto');
    })();
    return () => { valeAinda = false; };
  }, [ultimaSalva]);

  useEffect(() => {
    if (!VOZ_ATIVA) return; // voz desligada nesta semana — formulário é digitado
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SR) {
      recRef.current = new SR();
      recRef.current.lang = 'pt-BR';
      recRef.current.continuous = true;
      recRef.current.interimResults = false;
      recRef.current.onresult = (ev: any) => {
        let texto = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) texto += ev.results[i][0].transcript;
        setOs(prev => ({ ...prev, memoria_calculo: (prev.memoria_calculo ? prev.memoria_calculo + ' ' : '') + texto.trim() }));
      };
      recRef.current.onend = () => setOuvindo(false);
    }
  }, []);

  const ditar = () => {
    if (!recRef.current) { setMsg('Ditado não suportado neste navegador — use o Chrome.'); return; }
    if (ouvindo) { recRef.current.stop(); setOuvindo(false); }
    else { recRef.current.start(); setOuvindo(true); }
  };

  const campo = (k: keyof OSCampo, v: any) => setOs(prev => {
    const novo: any = { ...prev, [k]: v };
    // v95: marcar CONCLUÍDO carimba a data se ela estiver vazia.
    // Até aqui status e data eram campos independentes: o campo marcava
    // Concluído e deixava a conclusão em branco. Em 07-11/09 isso deixou 15
    // O.S. "concluídas" sem data nenhuma (L126..L134, 2319, 2409, NS05,
    // NS06, N03, ES01) — e medição é por período: O.S. sem data de
    // conclusão não tem como entrar em mês nenhum.
    // Só PREENCHE o que está vazio; nunca sobrescreve data já informada, e
    // nunca apaga ao trocar o status de volta.
    if (k === 'status' && /^(Conclu|Assinatura)/.test(String(v)) && !novo.conclusao) {
      novo.conclusao = hojeLocal();
    }
    return novo;
  });

  const limpar = () => { try { localStorage.removeItem(chaveRascunho); } catch { /* ok */ } setRascunho(null); setOs(vaziaPara(usuario)); setFotos([]); setKit({}); setKitAberto(false); setMsg(''); setUltimaSalva(null); setMsgShare(''); setLegendaPendente(null); setAvisoLink(''); aoCancelarEdicao(); };

  const mudaKit = (descricao: string, delta: number) =>
    setKit(prev => {
      const q = Math.max(0, (prev[descricao] || 0) + delta);
      const novo = { ...prev };
      if (q === 0) delete novo[descricao]; else novo[descricao] = q;
      return novo;
    });

  const itensKit = KIT_EMERGENCIAL
    .filter(i => kit[i.descricao] > 0)
    .map(i => ({ descricao: i.descricao, quantidade: kit[i.descricao], unidade: i.unidade }));

  // guia de medida específico pelo texto do serviço (fórmula EMOP certa)
  const guia = guiaMedida(`${os.servico} ${os.solicitado || ''}`.trim(), os.area);

  const salvar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (salvando) return; // anti duplo-toque (refatoração sênior 06/07)
    // ===== validações SÍNCRONAS (antes de travar o botão) =====
    if (!os.unidade.trim()) { setMsg('Informe a unidade (escola).'); return; }
    if (equipe && !os.executor) { setMsg('Toque em QUEM EXECUTOU (botões da equipe).'); return; }
    // MEDIÇÃO FECHADA é intocável pelo campo (spec do engenheiro) —
    // só a vigente edita; gestão corrige com essa responsabilidade
    if (!ehGestor && os.id && (os.medicao || '').trim() && os.medicao !== medDoMes()) {
      setMsg(`🔒 Esta O.S. está na ${os.medicao} (medição FECHADA) — não pode mais ser alterada. Fale com a gestão.`);
      return;
    }
    // SÓ CONCLUI COMPLETA — ajuste Renan 08/07: memória + executor seguem
    // obrigatórios; FOTO virou confirmável (O.S. chega assinada e a foto
    // está no grupo do WhatsApp — o campo dá baixa, evidência anexa depois)
    if (!ehGestor && os.status === 'Concluído') {
      const falta: string[] = [];
      if (!(os.memoria_calculo || '').trim()) falta.push('memória de cálculo');
      if (!(os.executor || '').trim()) falta.push('executor');
      if (falta.length > 0) { setMsg(`⛔ Para CONCLUIR falta: ${falta.join(' + ')}. Sem as informações a O.S. não será concluída.`); return; }
      if ((os.foto_urls?.length || 0) + fotos.length === 0 &&
          !confirm('Concluir SEM FOTO no app?\n\nOK só se a foto já está no GRUPO do WhatsApp — a gestão confere e anexa depois.')) {
        setMsg('Conclusão pausada — anexe a foto ou confirme que ela está no grupo.');
        return;
      }
    }
    // v96: GARANTE O CONTRATO. Até aqui a O.S. nascia sem ele — só quem tem
    // o botão dos dois contratos preenchia, e o resultado foi 99,5% das
    // 2.621 O.S. com o campo vazio. Isso trava a unificação: não dá para
    // juntar um terceiro contrato num banco onde o discriminador do segundo
    // não funciona. A unidade decide, igual à saída de material (v91).
    if (!(os.contrato || '').trim() && os.unidade.trim()) {
      const ct = contratoDaUnidade(os.unidade);
      setOs(prev => ({ ...prev, contrato: ct }));
      os.contrato = ct;   // o payload abaixo lê de `os`, não do estado novo
    }
    // ===== daqui pra baixo é assíncrono: botão TRAVADO =====
    setSalvando(true);
    setMsg('');
    // GUARDA ANTI-DUPLICATA (caso real 06/07: digitaram "79" seguindo a
    // contagem do papel e colidiu com a O.S. 79 oficial de janeiro)
    if (!os.id && os.numero) {
      const existe = await osService.numeroExiste(Number(os.numero));
      if (existe) {
        if (!ehGestor) {
          setSalvando(false);
          setMsg(`⛔ A O.S. ${os.numero} JÁ EXISTE (${existe.unidade} · ${existe.status}). Se a sua é NOVA, deixe o Nº VAZIO — o sistema gera o ${prefixoRef ?? 'F'}-nº sozinho. Se é a mesma, ache-a na lista e edite pelo lápis.`);
          return;
        }
        if (!confirm(`O.S. ${os.numero} já existe (${existe.unidade} · ${existe.status}). Criar DUPLICADA mesmo assim?`)) { setSalvando(false); return; }
      }
    }

    // AUDITORIA: se o upload de foto falhar (sinal ruim na escola), NÃO salva
    // silenciosamente sem evidência — pergunta antes. Foto perdida = risco de glosa.
    // v99: progresso foto a foto. Sem isto o botão só girava e o Caleb
    // achou que tinha travado — a mesma dor que o Renato teve no
    // compartilhamento (v87), do outro lado do fluxo.
    // v106: renova a credencial ANTES de começar, se ela estiver perto de
    // vencer. Dois celulares dividem o mesmo login (Leandro+Caleb, e o Queiroz
    // também) e o app fica horas no bolso com a tela apagada — é aí que a
    // sessão morre e o envio inteiro é recusado de uma vez.
    if (fotos.length) setMsg('conferindo a conexão…');
    await osService.garanteSessao();

    if (fotos.length) setMsg(`enviando fotos… 0/${fotos.length}`);
    const { urls: novas, falhas, erros, urlPorIndice } = await osService.uploadFotos(fotos,
      (feitas, total) => setMsg(`enviando fotos… ${feitas}/${total}`));
    setMsg('');
    if (falhas > 0) {
      // v103: DIZ O MOTIVO. "sinal fraco?" era chute em cima de qualquer falha,
      // inclusive das que tentar de novo nunca resolve (cota, sessão expirada).
      const motivo = erros.length ? `\n\nMOTIVO: ${erros.join('\n')}` : '';
      const segue = confirm(
        `⚠️ ${falhas} de ${fotos.length} foto(s) NÃO subiram.${motivo}\n\n` +
        `OK = salvar assim mesmo, SEM essas fotos\n` +
        `Cancelar = guardar as que já subiram e tentar de novo só as que faltaram`);
      if (!segue) {
        // v103: guarda o que JÁ subiu e deixa na tela só o que falhou. Antes as
        // urls boas eram descartadas e o reenvio subia o lote INTEIRO de novo —
        // as do lote anterior viravam arquivo órfão no bucket, para sempre, e é
        // assim que o storage foi de 1 GB para 2,43 GB.
        setOs(o => ({ ...o, foto_urls: [...o.foto_urls, ...novas] }));
        setFotos(fs => fs.filter((_, i) => !urlPorIndice[i]));
        setSalvando(false);
        setMsg(`${novas.length} foto(s) já guardadas. Faltam ${falhas} — aperte salvar de novo que só elas sobem.`
          + (erros.length ? ` ${erros[0]}` : ''));
        return;
      }
    }
    const urls = [...os.foto_urls, ...novas];

    // v109: RECHECAGEM pós-upload. O link do fiscal distribui o MESMO número
    // pro grupo inteiro: dois colegas passam juntos pela guarda lá de cima e
    // o upload leva minutos — sem índice único no banco, a segunda gravação
    // entraria DUPLICADA em silêncio. Confere de novo a um passo do insert.
    if (!os.id && os.numero && !ehGestor) {
      const corrida = await osService.numeroExiste(Number(os.numero));
      if (corrida) {
        if (novas.length) { setOs(o => ({ ...o, foto_urls: urls })); setFotos([]); }
        setSalvando(false);
        setMsg(`⛔ Enquanto as fotos subiam, outro colega registrou a O.S. ${os.numero} (${corrida.unidade} · ${corrida.status}). Ache-a na LISTA e complete pelo lápis — NÃO registre de novo.`);
        return;
      }
    }

    // GEO (Renan 08/07): carimba onde o celular estava ao salvar — prova
    // de presença na escola. NÃO trava o salvamento: sem sinal ou sem
    // permissão, segue sem coordenada.
    const geo = await new Promise<string | null>(res => {
      if (!('geolocation' in navigator)) return res(null);
      const t = setTimeout(() => res(null), 4000);
      navigator.geolocation.getCurrentPosition(
        p => { clearTimeout(t); res(`${p.coords.latitude.toFixed(6)},${p.coords.longitude.toFixed(6)} ±${Math.round(p.coords.accuracy)}m`); },
        () => { clearTimeout(t); res(null); },
        { enableHighAccuracy: true, timeout: 3500, maximumAge: 60000 }
      );
    });

    // itens do kit entram por escrito nos materiais da O.S. (rastro na própria O.S.)
    const textoKit = itensKit.map(i => `${i.quantidade} ${i.unidade} ${i.descricao}`).join(' + ');
    const materiais = [os.materiais.trim(), textoKit ? `[KIT] ${textoKit}` : ''].filter(Boolean).join('\n');

    const dados = { ...os, materiais, foto_urls: urls, numero: os.numero ? Number(os.numero) : null, ...(geo ? { geo } : {}) };
    // sem nº oficial → numeração automática da equipe/encarregado
    // (L/M emergência · G/C corretiva), gerada no banco
    // v88: na SAÚDE a fictícia leva a inicial da pessoa + S (QS01, NS01,
    // MS01…) — a mesma leitura da Educação, mas dá pra ver o contrato só
    // de bater o olho na referência, sem abrir a O.S.
    const prefixoUsado = prefixoRef ? (ehSaude ? `${prefixoRef}S` : prefixoRef) : undefined;
    const resultado = prefixoUsado
      ? await osService.salvarEquipe(dados, prefixoUsado)
      : await osService.salvar(dados);
    setSalvando(false);
    if (!resultado.ok) {
      // v103: a O.S. NÃO foi gravada e o erro cru não diz nada pra quem está em
      // campo. Em 21 e 22/09 seis gravações foram recusadas pelo banco e não
      // sobrou rastro nenhum — o motivo morria aqui. Agora o texto pede o print,
      // que é a única prova que chega até a gestão.
      console.error('FALHA AO SALVAR O.S.', { erro: resultado.erro, unidade: os.unidade, executor: os.executor });
      // v107: AS FOTOS JÁ ESTÃO NO SERVIDOR. Até aqui, quando a gravação
      // falhava, as URLs recém-criadas eram descartadas (eram uma const local)
      // e a próxima tentativa subia TUDO de novo — as do primeiro lote viravam
      // arquivo órfão no bucket, para sempre. É assim que o storage foi de
      // 1 GB para 2,43 GB. Agora elas entram no estado: a nova tentativa só
      // grava, não re-sobe.
      if (novas.length) { setOs(o => ({ ...o, foto_urls: urls })); setFotos([]); }
      setMsg('❌ A O.S. NÃO foi salva. Motivo: ' + (resultado.erro || 'sem resposta do servidor')
        + (novas.length ? ` — mas as ${novas.length} foto(s) já subiram e estão guardadas: é só apertar salvar de novo.` : '')
        + ' Tire um PRINT desta tela e mande no grupo. Não feche o app.');
      return;
    }

    const salva = resultado.os;
    const ref = salva && (salva.numero != null || salva.fict_ref || salva.numero_fict) ? refDaOS(salva) : '';

    // baixa automática do kit no estoque, amarrada ao nº que o banco devolveu
    let msgKit = '';
    if (!os.id && itensKit.length > 0 && baixaAuto) {
      const falhasKit = await osService.baixaKit(itensKit, ref, os.unidade);
      msgKit = falhasKit > 0
        ? ` ⚠️ ${falhasKit} item(ns) do kit NÃO baixaram no estoque — avise o João.`
        : ` 📦 ${itensKit.length} item(ns) do kit baixados no estoque${ref ? ' → O.S. ' + ref : ''}.`;
    }

    setMsg((os.id ? 'O.S. atualizada ✔' : `O.S. ${ref ? ref + ' ' : ''}registrada no banco central ✔`) + (falhas > 0 ? ` (sem ${falhas} foto(s) que falharam)` : '') + msgKit);
    // v78: a O.S. acabou de salvar com a foto no Storage — oferece mandar
    // pro grupo JÁ com a legenda padrão (antes a foto ia solta e ninguém
    // sabia de qual escola/serviço era).
    // v86: vale também na EDIÇÃO — quem corrigiu o texto precisa poder mandar
    // a versão certa pro grupo (caso real: E01 do Emiliano, 02/09).
    setSalvaFoiEdicao(!!os.id);
    setAvisoLink('');
    setUltimaSalva({ ...(salva || dados), foto_urls: urls } as OSCampo);
    setLegendaPendente(null);   // v110: pendência de cópia era da O.S. anterior
    try { localStorage.removeItem(chaveRascunho); } catch { /* ok */ }
    setRascunho(null);
    setOs(vaziaPara(usuario));
    setFotos([]);
    setKit({});
    setKitAberto(false);
    aoSalvar();
  };

  // classificação legada (I/II/III da planilha importada) continua visível na edição
  const classifs = os.classificacao && !CLASSIF_OPTIONS.includes(os.classificacao)
    ? [...CLASSIF_OPTIONS, os.classificacao] : CLASSIF_OPTIONS;

  return (
    <form onSubmit={salvar} className="bg-white rounded-2xl border border-stone-200 shadow-sm p-5 space-y-4">
      {/* v109: chegada pelo link do fiscal — boas-vindas ou alerta de duplicata */}
      {avisoLink && (
        <div className={`rounded-xl px-3 py-2.5 text-xs font-bold ${avisoLink.startsWith('⛔')
          ? 'bg-red-50 border border-red-200 text-red-700'
          : 'bg-sky-50 border border-sky-200 text-sky-800'}`}>
          {avisoLink}
        </div>
      )}
      {/* v111: o link do fiscal abre DENTRO do WhatsApp, onde o envio de
          fotos não existe (erro do Queiroz/Tito, 24/09 — mesmo dia em que o
          link estreou). Avisar NA CHEGADA, antes de a pessoa preencher tudo
          e só descobrir na hora de mandar pro grupo. Salvar funciona normal. */}
      {navegadorEmbutido() && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl px-3 py-2.5 text-xs font-bold text-amber-800">
          ⚠️ Você está no navegador de DENTRO do WhatsApp. Pode preencher e SALVAR
          normalmente — mas o envio pro grupo NÃO funciona aqui. Depois de salvar,
          abra o app pelo ÍCONE (ou ⋮ → "Abrir no Chrome"), ache a O.S. na LISTA
          e compartilhe de lá.
        </div>
      )}
      {/* recuperação do rascunho: celular travou? nada se perdeu */}
      {rascunho && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 flex items-center gap-2 flex-wrap text-xs font-bold text-amber-800">
          📝 Tem coisa digitada aqui que NÃO foi salva.
          <button type="button" onClick={() => { setOs({ ...rascunho }); setRascunho(null); }}
            className="bg-amber-500 text-white rounded-full px-3.5 py-1.5">↩ Recuperar</button>
          <button type="button" onClick={() => { try { localStorage.removeItem(chaveRascunho); } catch { /* ok */ } setRascunho(null); }}
            className="text-amber-700 underline">descartar</button>
        </div>
      )}
      <div className="space-y-2">
        <h2 className="font-bold text-stone-900">{os.id ? `Editando O.S. ${refDaOS(os)}` : 'Registrar O.S. de campo'}</h2>
        {/* tipo da atividade (decisão Renan 06/07): 3 opções no lugar do
            liga/desliga — emergencial continua acionando kit/prazos */}
        <div className="flex gap-2">
          {TIPO_OPTIONS.map(t => {
            const ativo = (os.tipo ?? (os.emergencial ? 'Emergencial' : '')) === t;
            const corAtivo = t === 'Emergencial' ? 'bg-red-600 text-white border-red-600' : 'bg-fpv-600 text-white border-fpv-600';
            return (
              <button key={t} type="button"
                onClick={() => setOs(prev => ({ ...prev, tipo: t, emergencial: t === 'Emergencial' }))}
                className={`flex-1 flex items-center justify-center gap-1.5 text-xs font-bold px-2 py-2 rounded-full border ${ativo ? corAtivo : 'bg-stone-50 text-stone-500 border-stone-200'}`}>
                {t === 'Emergencial' && <Siren size={13} />} {t.toUpperCase()}
              </button>
            );
          })}
        </div>
      </div>

      {equipe && !os.id && (
        <p className="text-[11px] text-stone-500 -mt-2">
          {equipe.apelido} · fiscal {equipe.fiscal} já preenchido · sem nº? o sistema gera o <b>{equipe.prefixo}-nº</b> na hora · medição vigente: <b>{medDoMes()}</b> (automática no fechamento)
        </p>
      )}
      {corretiva && !os.id && (
        <p className="text-[11px] text-stone-500 -mt-2">
          {corretiva.executor} já preenchido como executor · sem nº? o sistema gera o <b>{corretiva.prefixo}-nº</b> na hora · medição vigente: <b>{medDoMes()}</b>
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">Nº da O.S.</label>
          <input type="number" value={os.numero ?? ''} onChange={e => campo('numero', e.target.value ? Number(e.target.value) : null)}
            placeholder={prefixoRef ? `vazio = gera ${prefixoRef}-nº` : 'vazio = gera F-nº'}
            className="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-sm bg-stone-50 outline-none focus:border-fpv-500" />
        </div>
        <div>
          <label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">Data (edite se retroativo)</label>
          <input type="date" value={os.entrada ?? ''} onChange={e => campo('entrada', e.target.value || null)}
            className="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-sm bg-stone-50 outline-none focus:border-fpv-500" />
        </div>
      </div>

      <div>
        <label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">
          {ehSaude ? 'Unidade (saúde)' : 'Unidade (escola)'}
        </label>
        {/* v89: na SAÚDE o fiscal vem da própria unidade (regra Renan 03/09):
            posto → Fernando · SEMUSA → Elisangela · resto → Cunha. Na
            Educação o fiscal continua vindo da zona do login. */}
        <input list="escolas" value={os.unidade} required
          onChange={e => {
            const v = e.target.value;
            if (ehSaude) setOs(prev => ({ ...prev, unidade: v, fiscal: fiscalDaUnidadeSaude(v) }));
            else campo('unidade', v);
          }}
          placeholder="comece a digitar…"
          className="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-sm bg-stone-50 outline-none focus:border-fpv-500" />
        {/* v87: a digitação rápida segue o contrato escolhido — 68 escolas
            na Educação, 38 unidades da SEMUSA na Saúde */}
        <datalist id="escolas">{(ehSaude ? UNIDADES_SAUDE : ESCOLAS).map(e => <option key={e} value={e} />)}</datalist>
        {/* v86: Emiliano e Gilson atendem OS DOIS contratos. O botão marca a
            qual a O.S. pertence — sem isso a medição da Educação puxa serviço
            da Saúde. As unidades de saúde entram na lista num segundo passo
            (decisão do Renan 02/09: por ora só o marcador). */}
        {DOIS_CONTRATOS.includes(usuario) && (
          <div className="flex gap-2 mt-2">
            {(['Educação', 'Saúde'] as const).map(c => {
              const ativo = (os.contrato || 'Educação') === c;
              return (
                <button key={c} type="button" onClick={() => {
                  // v88 (regra do Renan 03/09): SAÚDE é sempre emergencial —
                  // o contrato da Saúde só tem esse fluxo hoje. Marcar o botão
                  // já deixa a O.S. pronta; quem quiser muda depois.
                  if (c === 'Saúde') {
                    // fiscal fica no padrão Cunha e se ajusta sozinho quando a
                    // unidade for digitada (posto → Fernando, SEMUSA → Elisangela)
                    setOs(prev => ({ ...prev, contrato: c, emergencial: true, tipo: 'Emergencial', classificacao: 'Emergencial', fiscal: 'Cunha', unidade: '', local: '' }));
                  } else {
                    setOs(prev => ({ ...prev, contrato: c, fiscal: equipe?.fiscal ?? 'Wellington', unidade: '', local: '' }));
                  }
                }}
                  className={`flex-1 text-sm font-bold py-2.5 rounded-xl border transition ${ativo
                    ? (c === 'Saúde' ? 'bg-sky-600 text-white border-sky-600' : 'bg-fpv-600 text-white border-fpv-600')
                    : 'bg-white text-stone-500 border-stone-200'}`}>
                  {c === 'Saúde' ? '🏥' : '🏫'} {c}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* v81: ONDE dentro da unidade — vai na legenda que o campo manda no
          grupo ("Local: Consultório 03 recepção principal"). Texto livre com
          sugestões: cada escola tem nome próprio pras salas. */}
      <div>
        <label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">
          Local <span className="font-medium normal-case text-stone-400">— onde dentro da unidade</span>
        </label>
        <input list="locais" value={os.local || ''} onChange={e => campo('local', e.target.value)}
          placeholder="ex.: Cozinha · Sala 12 · Banheiro dos alunos"
          className="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-sm bg-stone-50 outline-none focus:border-fpv-500" />
        <datalist id="locais">
          {(ehSaude ? LOCAIS_SAUDE : ['Cozinha', 'Refeitório', 'Banheiro dos alunos', 'Banheiro dos professores',
            'Secretaria', 'Direção', 'Sala de aula', 'Pátio', 'Quadra', 'Corredor', 'Recepção', 'Almoxarifado',
            'Depósito', 'Despensa', 'Berçário', 'Biblioteca', 'Sala de recursos', 'Vestiário',
            'Telhado', 'Caixa d\'água', 'Portão de entrada', 'Área externa']).map(l => <option key={l} value={l} />)}
        </datalist>
      </div>

      {/* executor em 1 toque: membros da equipe do login */}
      {equipe && (
        <div>
          <label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">Quem executou (equipe)</label>
          <div className="flex gap-2 flex-wrap">
            {equipe.membros.map(m => (
              <button key={m} type="button" onClick={() => campo('executor', m)}
                className={`rounded-full border px-3.5 py-2 text-xs font-bold ${os.executor === m ? 'bg-fpv-600 text-white border-fpv-600' : 'bg-white text-stone-600 border-stone-200'}`}>
                {m}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">Fiscal</label>
          <select value={os.fiscal} onChange={e => campo('fiscal', e.target.value)}
            className="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-sm bg-stone-50 outline-none focus:border-fpv-500">
            {FISCAL_OPTIONS.map(f => <option key={f}>{f}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">Classificação</label>
          <select value={os.classificacao} onChange={e => campo('classificacao', e.target.value)}
            className="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-sm bg-stone-50 outline-none focus:border-fpv-500">
            {classifs.map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
        {!equipe && (
          <div>
            <label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">Executor</label>
            <input list="executores" value={os.executor} onChange={e => campo('executor', e.target.value)}
              className="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-sm bg-stone-50 outline-none focus:border-fpv-500" />
            <datalist id="executores">{EXECUTOR_OPTIONS.map(x => <option key={x} value={x} />)}</datalist>
          </div>
        )}
        <div>
          <label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">Status</label>
          <select value={os.status} onChange={e => campo('status', e.target.value)}
            className="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-sm bg-stone-50 outline-none focus:border-fpv-500">
            {STATUS_OPTIONS.map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">Conclusão</label>
          <input type="date" value={os.conclusao ?? ''} onChange={e => campo('conclusao', e.target.value || null)}
            className="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-sm bg-stone-50 outline-none focus:border-fpv-500" />
        </div>
        {/* medição SAIU do painel do campo (decisão Renan 05/07): entra
            automática no fechamento — MED do mês vigente. Gestão ainda edita. */}
        {ehGestor && (
          <div>
            <label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">Medição</label>
            <select value={os.medicao} onChange={e => campo('medicao', e.target.value)}
              className="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-sm bg-stone-50 outline-none focus:border-fpv-500">
              {(os.medicao && !MED_OPTIONS.includes(os.medicao) ? [...MED_OPTIONS, os.medicao] : MED_OPTIONS)
                .map(m => <option key={m} value={m}>{m || '—'}</option>)}
            </select>
          </div>
        )}
      </div>

      <div>
        <label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">O que o fiscal solicitou</label>
        <textarea value={os.solicitado ?? ''} onChange={e => campo('solicitado', e.target.value)} rows={2}
          placeholder="a demanda que chegou (e-mail, WhatsApp ou verbal do fiscal)"
          className="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-sm bg-stone-50 outline-none focus:border-fpv-500 resize-y" />
      </div>

      <div>
        <label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">Serviço executado</label>
        <textarea value={os.servico} onChange={e => campo('servico', e.target.value)} rows={2}
          placeholder="ex.: troca de 2 sifões e 1 torneira no banheiro masc. bloco B"
          className="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-sm bg-stone-50 outline-none focus:border-fpv-500 resize-y" />
      </div>

      <div>
        <label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">Materiais utilizados</label>
        <textarea value={os.materiais} onChange={e => campo('materiais', e.target.value)} rows={2}
          placeholder="ex.: 2 UND sifão + 1 UND torneira + 1 UND fita teflon"
          className="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-sm bg-stone-50 outline-none focus:border-fpv-500 resize-y" />
      </div>

      {/* KIT EMERGENCIAL (spec Nicolas): lista padrão, baixa automática no estoque */}
      {!os.id && (equipe || os.emergencial) && (
        <div className="border border-red-100 bg-red-50/40 rounded-xl p-3">
          <button type="button" onClick={() => setKitAberto(a => !a)}
            className="w-full flex items-center gap-2 text-sm font-bold text-red-700">
            <PackageMinus size={16} /> Kit emergencial
            {itensKit.length > 0 && <span className="text-[11px] bg-red-600 text-white rounded-full px-2 py-0.5">{itensKit.length}</span>}
            <span className="ml-auto text-stone-400 font-medium text-xs">{kitAberto ? 'fechar ▲' : 'usar itens do kit ▼'}</span>
          </button>
          {kitAberto && (
            <div className="mt-3 space-y-1.5">
              {KIT_EMERGENCIAL.map(i => (
                <div key={i.descricao} className="flex items-center gap-2 text-sm bg-white border border-stone-100 rounded-lg px-3 py-1.5">
                  <span className="flex-1 min-w-0 truncate text-stone-700">{i.descricao}</span>
                  <span className="text-[10px] text-stone-400">{i.unidade}</span>
                  <button type="button" onClick={() => mudaKit(i.descricao, -1)} className="p-1 text-stone-400 hover:text-red-600"><Minus size={14} /></button>
                  <span className={`w-7 text-center font-bold tabular-nums ${kit[i.descricao] ? 'text-red-700' : 'text-stone-300'}`}>{kit[i.descricao] || 0}</span>
                  <button type="button" onClick={() => mudaKit(i.descricao, +1)} className="p-1 text-stone-400 hover:text-fpv-600"><Plus size={14} /></button>
                </div>
              ))}
              <label className="flex items-center gap-2 text-xs font-bold text-stone-600 pt-1 cursor-pointer">
                <input type="checkbox" checked={baixaAuto} onChange={e => setBaixaAuto(e.target.checked)} />
                dar baixa automática no estoque ao salvar
              </label>
            </div>
          )}
        </div>
      )}

      <div>
        <label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">Memória de cálculo (medidas do campo)
          {VOZ_ATIVA && (
            <button type="button" onClick={ditar}
              className={`float-right flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full border transition-colors ${ouvindo ? 'bg-red-500 text-white border-red-500 animate-pulse' : 'bg-fpv-50 text-fpv-700 border-fpv-100 hover:bg-fpv-100'}`}>
              <Mic size={13} /> {ouvindo ? 'Ouvindo… toque p/ parar' : 'Ditar por voz'}
            </button>
          )}
        </label>
        {(os.servico || os.solicitado) && (
          <p className="text-[11px] text-fpv-700 bg-fpv-50 border border-fpv-100 rounded-lg px-2.5 py-1.5 mb-1.5">📐 {guia}</p>
        )}
        {/* ATALHOS DA MEMÓRIA (Renan 09/07): o peão com dificuldade monta a
            memória em TOQUES — começa pelo serviço já registrado, soma os
            materiais e o molde da medida; só completa os números. */}
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {!(os.memoria_calculo || '').trim() && (os.servico || os.solicitado) && (
            <button type="button"
              onClick={() => campo('memoria_calculo', `${(os.servico || os.solicitado || '').trim()} — `)}
              className="text-[11px] font-bold bg-fpv-600 text-white rounded-full px-3 py-1.5">
              ⚡ Começar pelo serviço
            </button>
          )}
          {(os.materiais || '').trim() !== '' && (
            <button type="button"
              onClick={() => campo('memoria_calculo', `${(os.memoria_calculo || '').trim()}${(os.memoria_calculo || '').trim() ? '\n' : ''}Materiais: ${(os.materiais || '').trim()} — `)}
              className="text-[11px] font-bold bg-white text-fpv-700 border border-fpv-200 rounded-full px-3 py-1.5">
              + materiais usados
            </button>
          )}
          <button type="button" onClick={() => campo('memoria_calculo', `${os.memoria_calculo} ___ x ___ = ___ m²`.trim())}
            className="text-[11px] font-bold bg-white text-stone-600 border border-stone-200 rounded-full px-3 py-1.5">+ m² (L×A)</button>
          <button type="button" onClick={() => campo('memoria_calculo', `${os.memoria_calculo} ___ m lineares`.trim())}
            className="text-[11px] font-bold bg-white text-stone-600 border border-stone-200 rounded-full px-3 py-1.5">+ metros</button>
          <button type="button" onClick={() => campo('memoria_calculo', `${os.memoria_calculo} ___ und`.trim())}
            className="text-[11px] font-bold bg-white text-stone-600 border border-stone-200 rounded-full px-3 py-1.5">+ unidades</button>
        </div>
        <textarea value={os.memoria_calculo} onChange={e => campo('memoria_calculo', e.target.value)} rows={3}
          placeholder="toque nos botões acima e complete os números — ex.: parede 3,85 × 1,20 = 4,62 m²"
          className="w-full border border-stone-200 rounded-lg px-3 py-2.5 text-sm bg-stone-50 outline-none focus:border-fpv-500 resize-y" />
      </div>

      <div>
        <label className="block text-[11px] font-bold uppercase text-stone-500 mb-1">
          Fotos (antes / depois)
          <span className="font-medium normal-case text-stone-400"> — até {MAX_FOTOS} por O.S.</span>
        </label>
        {/* v85: o limite era 7 e descartava em SILÊNCIO — o Caleb mandou 7,
            tentou a 8ª e o app não disse nada (parecia que tinha travado).
            Agora avisa quantas entraram e quantas ficaram de fora. */}
        <input ref={fotoRef} type="file" accept="image/*" multiple className="hidden" disabled={salvando}
          onChange={e => {
            if (e.target.files) {
              const selecionadas = Array.from(e.target.files) as File[];
              const jaTem = fotos.length + (os.foto_urls?.length || 0);
              const cabem = Math.max(0, MAX_FOTOS - jaTem);
              const entram = selecionadas.slice(0, cabem);
              const sobraram = selecionadas.length - entram.length;
              if (entram.length) setFotos(prev => [...prev, ...entram]);
              setMsg(sobraram > 0
                ? `📷 ${entram.length} foto(s) anexada(s). ${sobraram} não entrou(ram): o limite é ${MAX_FOTOS} por O.S. (você já tem ${jaTem + entram.length}). Salve esta e registre o restante na próxima, ou apague alguma acima.`
                : `📷 ${entram.length} foto(s) anexada(s) — ${jaTem + entram.length}/${MAX_FOTOS}.`);
            }
            e.target.value = '';
          }} />
        {/* v107: a área de fotos TRAVA durante o envio. Sem isso o operador
            anexava mais fotos no meio do upload — elas apareciam na tela e no
            contador, mas não estavam no lote em voo, e o setFotos([]) do
            sucesso apagava tudo enquanto a tela dizia "registrada no banco
            central". Foto de prova sumindo em silêncio. */}
        <div className="flex flex-wrap gap-2 items-center">
          <button type="button" disabled={salvando} onClick={() => fotoRef.current?.click()}
            className="flex items-center gap-2 text-sm font-bold text-fpv-700 bg-fpv-50 border border-fpv-100 px-4 py-2.5 rounded-lg hover:bg-fpv-100 disabled:opacity-40">
            <Camera size={16} /> {salvando ? 'enviando…' : 'Tirar / anexar foto'}
          </button>
          {fotos.map((f, i) => (
            <span key={i} className="flex items-center gap-1 text-xs bg-stone-100 border border-stone-200 rounded-full px-3 py-1.5">
              📷 {f.name.slice(0, 14)}…
              <button type="button" disabled={salvando} onClick={() => setFotos(fs => fs.filter((_, j) => j !== i))}><X size={12} /></button>
            </span>
          ))}
          {os.foto_urls.length > 0 && <span className="text-xs text-stone-400">{os.foto_urls.length} já no banco</span>}
          <span className={`text-xs font-bold ${fotos.length + (os.foto_urls?.length || 0) >= MAX_FOTOS ? 'text-amber-700' : 'text-stone-400'}`}>
            {fotos.length + (os.foto_urls?.length || 0)}/{MAX_FOTOS}
          </span>
        </div>
      </div>

      {msg && <div className="text-sm font-medium text-fpv-700 bg-fpv-50 border border-fpv-100 rounded-lg px-3 py-2">{msg}</div>}

      {/* v78: mandar pro grupo COM legenda, na hora — a foto para de ir solta */}
      {ultimaSalva && (
        <div className="bg-white border-2 border-fpv-200 rounded-xl p-3 space-y-2">
          <p className="text-[12px] font-bold text-stone-800">
            {salvaFoiEdicao ? `Corrigiu a ${refDaOS(ultimaSalva)} — mandar a versão certa pro grupo?` : `Mandar a ${refDaOS(ultimaSalva)} pro grupo?`}
            <span className="font-medium text-stone-500"> vai com a legenda padrão{(ultimaSalva.foto_urls?.length || 0) > 0 ? ` e ${ultimaSalva.foto_urls.length} foto(s)` : ''}.</span>
          </p>
          <div className="flex gap-2">
            {/* v87: TRAVA o botão enquanto prepara — o Renato clicou várias
                vezes achando que travou, e cada clique baixava as fotos de
                novo. Agora mostra o progresso foto a foto. */}
            <button type="button" disabled={compartilhando || preparo === 'baixando'} onClick={async () => {
              // v106: a trava do `disabled` sozinha NAO basta. setState do React
              // e assincrono: dois toques no mesmo frame enxergam
              // compartilhando=false e passam os DOIS — cada um abrindo uma
              // folha de compartilhamento, ou seja, duas mensagens no grupo
              // para a mesma O.S. O ref muda na hora e fecha a porta.
              // (o ListaOS ganhou esta mesma trava na v105; aqui faltava)
              if (emShare.current) return;
              emShare.current = true;
              setCompartilhando(true);
              setLegendaPendente(null);   // v110: tentativa nova zera a pendência
              const n = ultimaSalva.foto_urls?.length || 0;
              // try/finally OBRIGATORIO: sem ele, uma exceção aqui deixaria o
              // ref travado em true e o botão morto até a tela ser remontada —
              // seria trocar "duplica" por "não compartilha nunca mais".
              let r: any = 'erro';
              try {
                // v108: SE AS FOTOS JÁ ESTÃO PRONTAS, a folha abre AGORA, dentro
                // deste toque. Esse é o ponto da mudança: o navegador só abre a
                // folha de compartilhamento logo depois do dedo sair da tela, e
                // baixar 6 fotos no sinal da escola estourava esse prazo — ele
                // recusava, a tela mandava colar à mão, o operador colava e
                // depois tocava de novo, e o grupo recebia o cartão DUAS VEZES.
                if (preparo === 'pronto' && fotosProntas.current) {
                  r = await enviarOS(legendaOS(ultimaSalva, medDoMes()), fotosProntas.current, n);
                } else {
                  // ainda baixando (ou sem foto): faz o caminho de um passo
                  setMsgShare(n > 3 ? `preparando ${n} fotos… pode levar alguns segundos no sinal da escola` : 'preparando…');
                  r = await compartilharOS(ultimaSalva, medDoMes(), {
                    aoProgredir: (feitas, total) => setMsgShare(`preparando fotos… ${feitas}/${total}`),
                  });
                }
              } catch {
                r = 'erro';
              } finally {
                emShare.current = false;
                setCompartilhando(false);
              }
              // v92: 'sem-fotos' e 'parcial' PRECISAM aparecer. Antes os dois
              // caíam em "✔ enviado" e o cara ia embora achando que a foto
              // tinha ido — foi o caso do Emiliano.
              setMsgShare(
                // v103: O.S. SEM foto nenhuma caía nesta mesma linha e a tela
                // dizia "+ todas as fotos". Foi o que o Caleb viu em 22/09: o
                // upload tinha falhado, a O.S. salvou vazia, o grupo recebeu só
                // a legenda e o app garantiu que as fotos tinham ido.
                r === 'compartilhado' && n === 0 ? '⚠️ foi SÓ A LEGENDA — esta O.S. não tem NENHUMA foto salva. As fotos não subiram; edite a O.S. e anexe de novo.' :
                r === 'compartilhado' ? `✔ enviado: cartão da O.S. + ${n} foto(s), num álbum só` :
                r === 'compartilhado-parcial' ? `⚠️ foi o cartão e PARTE das fotos — este aparelho não aceita o lote inteiro. Mande as que faltam pela galeria.` :
                // v103: esta linha agora cobre DUAS causas — o aparelho não
                // aceitar anexo, e as fotos não terem baixado do servidor.
                // Antes o segundo caso mentia "✔ enviado com todas as fotos".
                r === 'compartilhado-sem-fotos' ? '⚠️ SÓ O TEXTO foi — NENHUMA foto chegou no grupo. Ou as fotos não baixaram (sinal), ou este aparelho não aceita anexo. Mande as fotos pela galeria, no mesmo grupo.' :
                r === 'copiado' ? '📋 legenda copiada — cole no grupo e anexe as fotos' :
                // v110: "está copiada" SÓ quando a cópia foi confirmada. O caso
                // do Leony (24/09): a folha era recusada, a cópia falhava calada
                // e a tela mandava colar — colava-se o que estivesse na área de
                // transferência de antes. Agora o 'erro' seco ganha um botão
                // "copiar legenda" logo abaixo (toque novo = cópia aceita).
                // v111: app dentro do WhatsApp (link do fiscal) — share não existe lá
                r === 'navegador-embutido' ? '⚠️ NADA foi enviado: o app está aberto no navegador de DENTRO do WhatsApp, onde o envio de fotos não funciona. A O.S. está SALVA — abra o app pelo ÍCONE (ou ⋮ → "Abrir no Chrome"), ache-a na LISTA e compartilhe de lá.' :
                r === 'erro-copiado' ? `❌ NADA foi enviado — o aparelho recusou o compartilhamento. A legenda está copiada: cole no grupo e mande as fotos pela galeria.${motivoDoUltimoErro() ? ` (motivo: ${motivoDoUltimoErro()})` : ''}` :
                r === 'cancelado' ? '' : `❌ NADA foi enviado — o aparelho recusou o compartilhamento e a legenda NÃO foi copiada. Toque em COPIAR LEGENDA abaixo, cole no grupo e mande as fotos pela galeria.${motivoDoUltimoErro() ? ` (motivo: ${motivoDoUltimoErro()})` : ''}`
              );
              if (r === 'erro') setLegendaPendente(legendaOS(ultimaSalva, medDoMes()));
              // só some sozinho quando foi tudo; se faltou foto, o aviso fica
              // na tela até ele fechar (v103: O.S. vazia também segura o aviso)
              if (r === 'compartilhado' && n > 0) setTimeout(() => { setUltimaSalva(null); setMsgShare(''); setLegendaPendente(null); }, 1200);
            }} className="flex-1 bg-fpv-600 active:bg-fpv-700 disabled:bg-stone-300 text-white font-bold py-2.5 rounded-xl text-sm flex items-center justify-center gap-2">
              {compartilhando
                ? <><Loader2 size={15} className="animate-spin" /> enviando…</>
                : preparo === 'baixando'
                  ? <><Loader2 size={15} className="animate-spin" /> preparando as fotos…</>
                  : preparo === 'pronto' && fotosNoPonto > 0
                    ? `📤 ENVIAR AGORA — ${fotosNoPonto} foto(s) prontas`
                    : preparo === 'pronto'
                      ? '📤 Enviar só a legenda (as fotos não baixaram)'
                      : '📤 Compartilhar no grupo'}
            </button>
            <button type="button" onClick={() => { setUltimaSalva(null); setMsgShare(''); setLegendaPendente(null); }}
              className="px-4 border border-stone-300 rounded-xl text-sm font-bold text-stone-600">agora não</button>
          </div>
          {msgShare && <p className="text-[11px] text-stone-500">{msgShare}</p>}
          {/* v110: a cópia automática falhou — este botão é um toque NOVO, e
              com toque novo o navegador aceita escrever na área de
              transferência. Se nem assim for, o prompt mostra a legenda para
              copiar à mão. Nunca mais "está copiada" sem estar. */}
          {legendaPendente && (
            <button type="button" onClick={async () => {
              if (await copiarLegenda(legendaPendente)) {
                setLegendaPendente(null);
                setMsgShare('📋 legenda copiada — cole no grupo e mande as fotos pela galeria');
              } else {
                window.prompt('Copie a legenda (segure e selecione tudo):', legendaPendente);
              }
            }} className="w-full bg-amber-500 active:bg-amber-600 text-white font-bold py-2.5 rounded-xl text-sm">
              📋 COPIAR LEGENDA
            </button>
          )}
        </div>
      )}

      <div className="flex gap-3 pt-1">
        <button type="submit" disabled={salvando}
          className="flex-1 bg-fpv-500 hover:bg-fpv-600 text-white font-bold py-3.5 rounded-xl flex items-center justify-center gap-2 disabled:opacity-60">
          {salvando ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
          {salvando ? 'Enviando…' : (os.id ? 'Salvar alterações' : 'Salvar O.S.')}
        </button>
        <button type="button" onClick={limpar}
          className="px-4 py-3.5 rounded-xl border border-stone-200 text-stone-500 hover:bg-stone-50" title="Limpar">
          <Eraser size={18} />
        </button>
      </div>
    </form>
  );
};

export default NovaOS;
