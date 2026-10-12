import type { Question } from '../src/core/schema';
import { Markdown } from './markdown';

export function QuestionCard({ question, canSend, onAnswer }: { question: Question; canSend: boolean; onAnswer(text: string): void }) {
  return (
    <div className="question-card" role="group" aria-label="Pergunta do agente">
      <div className="question-title"><span className="spinner" aria-hidden="true" /> O agente perguntou</div>
      <div className="question-text md"><Markdown text={question.text} /></div>
      {question.options.length > 0 && (
        <div className="question-options">
          {question.options.map((o) => (
            <button key={o} className="option" disabled={!canSend} onClick={() => onAnswer(o)}>{o}</button>
          ))}
        </div>
      )}
      <div className="question-hint">
        {question.options.length > 0 ? 'Escolha uma opção ou escreva sua resposta abaixo.' : 'Escreva sua resposta abaixo.'}
        {question.source === 'heuristic' && ' Pergunta detectada pelo texto da resposta.'}
      </div>
    </div>
  );
}
