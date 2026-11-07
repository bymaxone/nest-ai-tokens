# Nota de design: reparo opt-in e autoverificável do `occurredAt` deslocado

Status: **apenas design. Nada está implementado.** Base: as medições do TASK-229 (builds reais v1.1.11 e v1.1.12, Prisma 6.19.3, sessões `Asia/Tokyo` e `America/Sao_Paulo`). O que um operador afetado vê, e por quê, está no README (seção "Records written before 1.1.12 on Prisma 6 under a non-UTC session zone").

## Fatos em que o reparo se apoia

1. O hash da cadeia é `chainHash(prevHash, {id, ...conteúdo})`: um SHA-256 canônico sobre o hash anterior, o id do registro e o hash do conteúdo (`src/server/utils/hash-chain.ts`). O `occurredAt` faz parte do conteúdo. Uma linha gravada com `occurredAt` deslocado falha em `verifyChain` nessa linha (medido: `valid: false`, `brokenAtRecordId` = a primeira linha deslocada).
2. Uma linha deslocada guarda `W = relógio_de_parede(T, Z)`: o instante verdadeiro `T` escrito como a hora de parede da zona `Z` da sessão (medido: 12:00Z gravado como 21:00 em Tóquio e 09:00 em São Paulo). Ler `W` como hora local em `Z` devolve `T`. Só há dois instantes possíveis na hora em que um relógio de horário de verão se repete; a hora inexistente não ocorre.
3. Logo, o valor verdadeiro é função de `(W, Z)` e o hash gravado é função do valor verdadeiro. Recalcular o hash com o candidato e compará-lo com o hash gravado é uma **prova**, não uma heurística: zona errada ou ramo de horário de verão errado produz outro hash e a linha é deixada como está.

## Proposta

**Planejador puro, sem caminho de escrita na biblioteca.** Adicionar `planOccurredAtRepair(records, { zones })` em `./shared` (zero dependências; `Intl.DateTimeFormat` para a aritmética de zona). Entrada: os registros encadeados de um tenant, como lidos do store, e uma lista de zonas candidatas. Saída, por registro: `ok` (o hash já confere), `repairable` (zona, ramo, `occurredAt` corrigido; o hash recalculado é igual ao gravado) ou `unproven` (nenhum candidato confere, ou o registro não tem hash). Não altera nada.

**Aplicar é ato do operador, com um papel privilegiado.** A regra crítica 2 (nenhum UPDATE de registro lançado) e o conselho do README (revogar `UPDATE` do papel da aplicação) proíbem um caminho de escrita na biblioteca. A saída do planejador vira uma lista revisável de `UPDATE ... SET "occurredAt" = <hora de parede UTC corrigida> WHERE id = ... AND "hash" = <hash gravado>` que um DBA executa numa única transação. A guarda `AND "hash"` torna o comando um no-op numa linha cujo hash gravado não é o planejado.

**Dry run é o padrão e o único modo que a biblioteca tem.** Por tenant (a cadeia é por tenant). O operador informa a lista de zonas: as zonas de sessão que suas conexões usaram na 1.1.11 ou antes; mais de uma é permitida (um host que mudou de região), e cada linha prova a sua própria zona.

**A verificação de que funcionou é a da própria biblioteca:** depois do UPDATE, `verifyChain(tenant)` devolve `valid: true`. Um palpite errado deixa a cadeia inválida exatamente nas linhas que não foram provadas.

## O que corrige e o que não corrige

Corrige: o `occurredAt` de todo registro de uso encadeado; assim, as janelas `from`/`to` do relatório de uso, do resumo de custo e dos intervalos de `verifyChain` voltam a ficar certas para essas linhas.

Não corrige, e não é provável por este método:

- Registros sem cadeia (hash chain desligada quando foram gravados, ou gravados antes de ela ser ligada): não há hash contra o qual provar. Ficam deslocados e saem como `unproven`.
- `createdAt`/`updatedAt` de registros anteriores à 1.1.8: nenhum hash os cobre. Poderiam ser derivados com o deslocamento que uma linha provada da mesma época mostra, mas derivar não é provar; o planejador apenas os reportaria.
- Janelas de orçamento (`windowStart` e os contadores de gasto), lançamentos de carteira (`effectiveAt`, `expiresAt`, portanto a expiração de créditos), versões de preço (`effectiveFrom`) e o `createdAt` dos orçamentos: deslocados pelo mesmo mecanismo na 1.1.11 e antes, e nenhum hash os cobre. As notas da 1.1.12 já dizem que não podem ser reparados. Um ledger reparado faz `reconcileWindow` produzir o gasto correto para as janelas que existem, mas as linhas de janela antigas, chaveadas por um `windowStart` deslocado, permanecem.

Portanto, as janelas erradas dos relatórios ficam corrigidas apenas para linhas encadeadas; orçamentos e expiração de carteira continuam como descrito nas notas da 1.1.12.

## Riscos

- A aritmética de zona é toda a dificuldade (hora repetida do horário de verão, mudanças históricas de regra, como o antigo horário de verão de São Paulo). A prova mitiga: um bug do planejador só pode produzir linhas `unproven`, nunca uma escrita errada, desde que o planejador compare o hash recalculado inteiro.
- A cadeia não tem chave: quem tem acesso de escrita já consegue recalcular uma cadeia (README, limite 2). O reparo só aceita um valor que reproduz o hash já gravado, então não concede nada que um atacante não tenha.
- Ordem de aplicação: o UPDATE muda `occurredAt` sob um hash que já confere com o novo valor, então executá-lo duas vezes é um no-op; executá-lo num tenant em escrita é seguro, porque as linhas novas (1.1.12) já verificam e saem como `ok`.

## Custo e recomendação

Um PR: o planejador (cerca de 150 linhas com a aritmética de zona, estimativa), testes com linhas reais da 1.1.11 (uma fixture gravada pelo build v1.1.11, como na medição do TASK-229) em Tóquio, São Paulo e um caso de hora repetida, e um procedimento no README; o bundle `shared` tem folga no orçamento de tamanho. O alcance é estreito (Prisma 6 sob zona de sessão diferente de UTC, na 1.1.11 ou antes, com a hash chain ligada). Recomendação: não construir de forma especulativa. Construir quando um host real pedir, porque então ele também fornece a lista de zonas e a fixture.
