import { useEffect, useRef, useState } from 'react';
import type { Question } from '../src/core/schema';
import { Markdown } from './markdown';

export function QuestionCard({ question, canSend, failures, onAnswer }: {
  question: Question;
  canSend: boolean;
  /** contador de respostas não entregues deste node: quando muda, a opção enviada volta e aparece "Tentar de novo" */
  failures: number;
  onAnswer(text: string): void;
}) {
  const [sent, setSent] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const seen = useRef(failures);
  useEffect(() => {
    if (failures === seen.current) return;
    seen.current = failures;
    if (sent !== null) {
      setFailed(sent);
      setSent(null);
    }
  }, [failures, sent]);
  const answer = (o: string) => {
    setFailed(null);
    setSent(o);
    onAnswer(o);
  };
  return (
    <div className="question-card" role="group" aria-label="Pergunta do agente">
      <div className="question-title"><span className="spinner" aria-hidden="true" /> O agente perguntou</div>
      <div className="question-text md"><Markdown text={question.text} /></div>
      {question.options.length > 0 && (
        <div className="question-options">
          {question.options.map((o) => (
            <button key={o} className={`option${sent === o ? ' is-sending' : ''}`} disabled={!canSend || sent !== null} onClick={() => answer(o)}>
              {sent === o ? `${o} · enviando…` : o}
            </button>
          ))}
        </div>
      )}
      {failed !== null && (
        <div className="question-hint question-failed" role="alert">
          A resposta não foi entregue. <button className="link" onClick={() => answer(failed)}>Tentar de novo</button>
        </div>
      )}
      <div className="question-hint">
        {!canSend
          ? 'Aguardando o agente terminar…'
          : question.options.length > 0 ? 'Escolha uma opção ou escreva sua resposta abaixo.' : 'Escreva sua resposta abaixo.'}
        {question.source === 'heuristic' && ' Pergunta detectada pelo texto da resposta.'}
      </div>
    </div>
  );
}
