// nowforge-spec: f8f984471ee861f0
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['asw_flow'],
        name: 'NowForge Speed Test A',
        description: 'When an incident is created with short description containing "speedtest-a", add a work note and log the action.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['asw_trigger'] },
        {
            table: 'incident',
            condition: 'short_descriptionLIKEspeedtest-a',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        wfa.action(action.core.updateRecord, { $id: Now.ID['asw_update_incident'] }, {
            table_name: 'incident',
            record: wfa.dataPill(params.trigger.current, 'reference'),
            values: TemplateValue({
                work_notes: 'NowForge Speed Test A: received',
            }),
        })

        wfa.action(action.core.log, { $id: Now.ID['asw_log'] }, {
            log_level: 'info',
            log_message: `NowForge Speed Test A ran for ${wfa.dataPill(params.trigger.current.number, 'string')}`,
        })
    }
)