// nowforge-spec: 759d6a76ad3fbfd8
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['nfe_flow'],
        name: 'NowForge Edit Test',
        description: 'Logs creation of incident with a formatted message.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['nfe_trigger'] },
        {
            table: 'incident',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        wfa.action(action.core.log, { $id: Now.ID['nfe_log'] }, {
            log_level: 'info',
            log_message: 'NowForge Edit Test ran for {{trigger.current.number}}',
        })
        wfa.action(action.core.log, { $id: Now.ID['nfe_log_6'] }, {
            log_level: 'info',
            log_message: 'T2 restart test',
        })
        wfa.action(action.core.updateRecord, { $id: Now.ID['nfe_update_record_7'] }, {
            record: wfa.dataPill(params.trigger.current, 'reference'),
            table_name: 'incident',
            values: TemplateValue({ state: 2 }),
        })
    }
)