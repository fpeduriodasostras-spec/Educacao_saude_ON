# ERROS E LIÇÕES — registro numerado (não regrida!)

Lições REAIS de produção da semana 04–07/07/2026. Antes de mexer no código,
confira se a sua mudança não reintroduz um destes. Padrão copiado do
método AIOS: erro numerado nunca volta.

## Campo / celular

- **#1 Cache de bundle no celular.** Usuário vê tela antiga e reporta "bug"
  que já foi corrigido. Diagnóstico: `VERSAO` no cabeçalho (App.tsx) — sempre
  bumpar a cada release e pedir print do número antes de investigar.
- **#2 Teclado móvel poluí credenciais.** Maiúscula automática + espaço no
  fim derrubavam login ("muita recusa"). Fix v39: trim + lowercase no e-mail,
  trim na senha, olhinho 👁, login por lista de nomes (ACESSOS).
- **#3 "Limpar dados do site" apaga permissão do mic E a sessão.** Nunca
  orientar limpeza de dados como troubleshooting sem avisar o efeito.
- **#4 Duplo-toque duplica registro.** Travar o botão com ref/state ANTES de
  qualquer `await`; destravar em todo early-return (v33).
- **#5 Campo digita o nº do papel.** Caso real: "79" digitado colidiu com a
  O.S. 79 oficial de janeiro. Guarda `numeroExiste()` bloqueia; gestor força
  com confirm (v29).
- **#6 FileList esvazia antes do setState.** `e.target.value = ''` limpa o
  FileList vivo; o updater roda depois e perde a seleção. Snapshot
  (`Array.from`) ANTES do setState (v37, achado da auditoria externa).
- **#23 "Está copiada" sem confirmar é mentira.** Depois de uma folha de
  compartilhamento recusada, o navegador costuma negar TAMBÉM o clipboard
  ("document is not focused"). Engolir o catch e afirmar a cópia fez o campo
  colar no grupo o conteúdo ANTIGO da área de transferência (caso Leony,
  24/09). Cópia sempre com prova: `copiarLegenda` devolve boolean (v110);
  falhou → botão COPIAR LEGENDA / prompt, porque toque novo = permissão nova.
- **#24 Link tocado no WhatsApp abre o app no navegador EMBUTIDO** (WebView),
  onde `navigator.share` não existe ou é recusado. O deep link do fiscal
  estreou na v109 e NO MESMO DIA Queiroz e Tito, "todos na versão nova",
  tiveram o envio recusado — não era versão velha, era o navegador de dentro
  do WhatsApp. SALVAR funciona no embutido; COMPARTILHAR não. v111:
  `navegadorEmbutido()` avisa na chegada e no envio ("salve aqui, compartilhe
  pela LISTA no app de verdade"), e toda recusa de share agora escreve o
  motivo técnico na mensagem — o print do campo virou o diagnóstico.

## Supabase / dados

- **#7 PostgREST corta GET em 1000 linhas.** Toda listagem grande pagina
  (`range`) até vir página incompleta (osService.listar). KPI sobre lista
  parcial = decisão errada silenciosa — por isso listar devolve `{dados, erro}`.
- **#8 Lote de INSERT exige chaves idênticas em todas as linhas** (PGRST102).
- **#9 Data em UTC.** `toISOString()` depois das 21h local grava AMANHÃ.
  Sempre `hojeLocal()`. Ao REPORTAR horários do banco: converter UTC→Brasília (-3h)
  — e cuidado com dupla conversão no PowerShell (`[datetime]` já localiza ISO com offset).
- **#10 RLS `USING (true)` em DELETE** = qualquer login apaga tudo via REST.
  Delete sempre por lista de e-mails no JWT (v16; auditoria).
- **#11 Numeração concorrente.** Dois celulares pegando L-nº no mesmo segundo:
  índice único parcial no banco + re-tentativa 3x no app (v22). Sequência F:
  piso calculado no app (v31) porque o setval travou no Studio (OOM do painel).
- **#12 Import de planilha não passa pelo trigger** quando `numero` vem
  preenchido; marcador de importado = `criado_por is null`. Filtros de
  "criado pelo app" usam isso.
- **#13 Match de texto digitado por humano.** "Gilson " (espaço no fim)
  quebrou confirmação de destinatário. Normalizar (lowercase + sem acento +
  trim) nos DOIS lados antes de comparar (v26).
- **#14 Env var na Vercel só entra em BUILD novo.** Colar a variável não muda
  o deploy que está no ar — precisa Redeploy. Diagnóstico: procurar o valor
  no bundle servido (curl no /assets/*.js).

## JS / React

- **#15 Closure congelada em callback de API de voz/evento.** Callback criado
  uma vez lê state velho para sempre. Usar ref (etapaRef, sugRef, segurandoRef).
- **#16 Web Speech do Chrome desliga sozinho em pausa de fala.** Não é bug do
  app: religar automático enquanto o dedo segura (v4 do chat).
- **#17 Realtime em rajada.** Vários eventos em sequência = N recargas.
  Sempre debounce (~1,2s) no handler.

## PowerShell 5.1 (máquina local, sem Python/Node)

- **#18 Não existem** `&&`/`||` de pipeline, `??`, `?.`, `-AsHashtable`.
  Lista de 1 elemento colapsa no pipeline (`Sort-Object`) — vírgula unária.
  `Out-File` padrão é UTF-16: usar `-Encoding utf8`. Script .ps1 com emoji ou
  acento precisa de BOM UTF-8.
- **#19 Excel via COM** (não há Python): sempre abrir read-only os originais
  do contrato; `f ($m[$r,c])` exige parênteses.

## Processo

- **#20 SQL enviado no chat não é SQL rodado.** Toda mudança de schema entra
  num arquivo .sql do repo E na ordem do DEPLOY.md; conferência final =
  CONFERENCIA-GERAL.sql (66 checks). Banco e app divergentes foi o maior
  risco apontado pela auditoria externa de 07/07.
- **#21 Chave/API key colada em chat = chave exposta.** Rotacionar. (3 apikeys
  Evolution seguem pendentes de rotação!)
- **#22 Adoção não é feature.** Dia 1: 12 retiradas sem RECEBI; dia 3: 76.
  Funcionalidade sem treino + cobrança de rotina não vira processo — boletim
  operacional + trilha de treinamento existem por isso.
