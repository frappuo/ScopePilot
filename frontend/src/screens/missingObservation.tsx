import { MESSAGES } from '../api/http';
import { Button, Notice, Screen } from '../components/ui';

// The body of the Ask and Quiz screens once the observation is gone (404).
export function MissingObservation({ onBack }: { onBack(): void }) {
  return <Screen fill>
    <Notice kind="error">{MESSAGES.notFound}</Notice>
    <Button variant="secondary" title="Back to logbook" onPress={onBack} />
  </Screen>;
}
