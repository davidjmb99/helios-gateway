export interface DebugStep {
  timestamp: string;
  type: 'webhook_received' | 'normalized' | 'buffer_waiting' | 'buffer_consolidated' | 'hermes_request' | 'hermes_response' | 'action_executed' | 'error';
  data: any;
}

export interface DebugEvent {
  trace_id: string;
  conversation_id: string;
  contact_id: string;
  timestamp: string;
  event: string;
  message_type: string;
  text: string;
  phone: string;
  patient_name: string;
  decision: 'ignored' | 'accepted' | 'buffered' | 'duplicate' | 'error' | 'sent_to_hermes';
  normalizedPayload?: any;
  hermesRequest?: any;
  hermesResponse?: any;
  actionsExecuted: Array<{ action: string; timestamp: string; data?: any; success: boolean }>;
  timeline: DebugStep[];
}

class DebugTracker {
  private events: DebugEvent[] = [];
  private maxEvents = 100; // Guardamos hasta 100 para un buen historial

  public addEvent(event: Omit<DebugEvent, 'actionsExecuted' | 'timeline'>) {
    const newEvent: DebugEvent = {
      ...event,
      actionsExecuted: [],
      timeline: [
        {
          timestamp: new Date().toISOString(),
          type: 'webhook_received',
          data: { text: event.text, decision: event.decision }
        }
      ]
    };
    
    // Evitar duplicados por trace_id
    const index = this.events.findIndex(e => e.trace_id === event.trace_id);
    if (index !== -1) {
      this.events[index] = { ...this.events[index], ...event };
      return;
    }

    this.events.unshift(newEvent);
    if (this.events.length > this.maxEvents) {
      this.events.pop();
    }
  }

  public updateEvent(traceId: string, updates: Partial<DebugEvent>) {
    const event = this.events.find(e => e.trace_id === traceId);
    if (event) {
      Object.assign(event, updates);
    }
  }

  public addTimelineStep(traceId: string, type: DebugStep['type'], data: any) {
    const event = this.events.find(e => e.trace_id === traceId);
    if (event) {
      event.timeline.push({
        timestamp: new Date().toISOString(),
        type,
        data
      });
    }
  }

  public addAction(traceId: string, action: string, success: boolean, data?: any) {
    const event = this.events.find(e => e.trace_id === traceId);
    if (event) {
      event.actionsExecuted.push({
        action,
        timestamp: new Date().toISOString(),
        data,
        success
      });
      event.timeline.push({
        timestamp: new Date().toISOString(),
        type: 'action_executed',
        data: { action, success, data }
      });
    }
  }

  public getEvents(filters: { conversation_id?: string; decision?: string; onlyErrors?: boolean } = {}) {
    let list = [...this.events];
    
    if (filters.conversation_id) {
      list = list.filter(e => e.conversation_id === filters.conversation_id);
    }
    if (filters.decision) {
      list = list.filter(e => e.decision === filters.decision);
    }
    if (filters.onlyErrors) {
      list = list.filter(e => e.decision === 'error' || e.timeline.some(t => t.type === 'error'));
    }

    return list;
  }

  public clear() {
    this.events = [];
  }

  public clearTenant(tenantId: string) {
    this.events = this.events.filter(e => e.normalizedPayload?.tenant_id !== tenantId);
  }
}

export const debugTracker = new DebugTracker();
