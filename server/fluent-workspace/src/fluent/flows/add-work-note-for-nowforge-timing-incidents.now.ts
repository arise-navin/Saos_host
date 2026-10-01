// nowforge-spec: 3deb54335724dec2
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['awfnt_flow'],
        name: 'Add Work Note for nowforge-timing Incidents',
        description: 'When an incident is created with short description containing "nowforge-timing", log an info message and add a work note.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['awfnt_trigger'] },
        {
            table: 'incident',
            condition: 'short_descriptionLIKEnowforge-timing',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        wfa.action(action.core.log, { $id: Now.ID['awfnt_log'] }, {
            log_level: 'info',
            log_message: `Handled incident ${wfa.dataPill(params.trigger.current.number, 'string')}`,
        })

        wfa.action(action.core.updateRecord, { $id: Now.ID['awfnt_add_work_note'] }, {
            table_name: 'incident',
            record: wfa.dataPill(params.trigger.current, 'reference'),
            values: TemplateValue({
                work_notes: 'Nowforge timing detected. Added work note automatically.',
            }),
        })
    }
)