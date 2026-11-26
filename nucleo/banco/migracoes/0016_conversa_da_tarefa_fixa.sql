-- A conversa de origem da tarefa leva canal, chave e instante juntos, e nunca muda depois de criada.
-- Cada coluna é conferida com IS NOT NULL antes de ser usada: um NULL no meio faria o WHEN valer NULL, e o gatilho não dispararia.
CREATE TRIGGER `tarefa_conversa_inteira` BEFORE INSERT ON `tarefa`
WHEN NOT (
  (NEW.`conversa_canal` IS NULL AND NEW.`conversa_chave` IS NULL AND NEW.`conversa_ate` IS NULL)
  OR (
    NEW.`conversa_canal` IS NOT NULL AND NEW.`conversa_chave` IS NOT NULL AND NEW.`conversa_ate` IS NOT NULL
    AND NEW.`conversa_canal` IN ('whatsapp', 'email') AND length(NEW.`conversa_chave`) >= 1 AND length(NEW.`conversa_ate`) >= 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'a conversa da tarefa leva canal, chave e ate juntos');
END;
--> statement-breakpoint
CREATE TRIGGER `tarefa_conversa_fixa` BEFORE UPDATE ON `tarefa`
WHEN NEW.`conversa_canal` IS NOT OLD.`conversa_canal` OR NEW.`conversa_chave` IS NOT OLD.`conversa_chave` OR NEW.`conversa_ate` IS NOT OLD.`conversa_ate`
BEGIN
  SELECT RAISE(ABORT, 'a conversa da tarefa não muda');
END;
