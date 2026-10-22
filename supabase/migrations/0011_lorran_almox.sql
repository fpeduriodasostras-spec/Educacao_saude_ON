-- =====================================================================
-- 0011 · LORRAN ENTRA COM OS MESMOS ACESSOS DO MARCIO
-- Banco da VPS (supabase.arkaisolutions.app.br) · 22/10/2026
--
-- O Lorran divide o almoxarifado com o Marcio Junior (pedido do Leony).
-- As políticas de RLS listam os e-mails na mão (ver 0004): sem isto o app
-- deixa o Lorran tocar no botão, mas o banco recusa a exclusão.
--
-- O que muda: 'lorran@fpv.app' entra em TODA policy de DELETE onde o
-- 'marcio@fpv.app' já está. SELECT/INSERT/UPDATE já valem para qualquer
-- login autenticado. Só permissão — NENHUM dado é alterado.
-- Idempotente: reescreve a lista inteira de cada policy (ALTER POLICY).
-- =====================================================================
begin;

alter policy "fpv_gestores_delete" on os_campo
  using (auth.jwt() ->> 'email' in
    ('lucas@fpv.app','rafael@fpv.app','marcio@fpv.app','renan@fpv.app','edmar@fpv.app','lorran@fpv.app'));

alter policy "almox_delete_restrito" on saida_material
  using (auth.jwt() ->> 'email' in
    ('lucas@fpv.app','rafael@fpv.app','marcio@fpv.app','renan@fpv.app','edmar@fpv.app','joao@fpv.app','lorran@fpv.app'));

alter policy "and_delete" on andaime_item
  using (auth.jwt() ->> 'email' in
    ('lucas@fpv.app','rafael@fpv.app','marcio@fpv.app','renan@fpv.app','edmar@fpv.app','joao@fpv.app','lorran@fpv.app'));

alter policy "andmov_delete" on andaime_movimento
  using (auth.jwt() ->> 'email' in
    ('lucas@fpv.app','rafael@fpv.app','marcio@fpv.app','renan@fpv.app','edmar@fpv.app','joao@fpv.app','lorran@fpv.app'));

alter policy "entrada_delete" on entrada_material
  using (auth.jwt() ->> 'email' in
    ('lucas@fpv.app','rafael@fpv.app','marcio@fpv.app','renan@fpv.app','edmar@fpv.app','joao@fpv.app','lorran@fpv.app'));

alter policy "estoque_delete" on estoque_item
  using (auth.jwt() ->> 'email' in
    ('lucas@fpv.app','rafael@fpv.app','marcio@fpv.app','renan@fpv.app','edmar@fpv.app','joao@fpv.app','lorran@fpv.app'));

alter policy "ferr_delete" on ferramenta
  using (auth.jwt() ->> 'email' in
    ('lucas@fpv.app','rafael@fpv.app','marcio@fpv.app','renan@fpv.app','edmar@fpv.app','joao@fpv.app','lorran@fpv.app'));

alter policy "solic_delete" on solicitacao_material
  using (auth.jwt() ->> 'email' in
    ('lucas@fpv.app','rafael@fpv.app','marcio@fpv.app','renan@fpv.app','edmar@fpv.app','joao@fpv.app','lorran@fpv.app'));

commit;
