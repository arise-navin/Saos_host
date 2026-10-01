// nowforge-spec: fb91d0ae894b2355
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['nstb_flow'],
        name: 'NowForge Speed Test B',
        description: 'When an incident is created with short description containing "speedtest-b", update work notes and log based on priority.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['nstb_trigger'] },
        {
            table: 'incident',
            condition: 'short_descriptionLIKEspeedtest-b',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        wfa.flowLogic.if(
            {
                $id: Now.ID['nstb_if_priority'],
                condition: `${wfa.dataPill(params.trigger.current.priority, 'integer')}=1`,
            },
            () => {
                wfa.action(
                    action.core.updateRecord,
                    { $id: Now.ID['nstb_update'] },
                    {
                        table_name: 'incident',
                        record: wfa.dataPill(params.trigger.current, 'reference'),
                        values: TemplateValue({
                            work_notes: 'NowForge Speed Test B: high priority',
                        }),
                    }
                )
                wfa.action(
                    action.core.log,
                    { $id: Now.ID['nstb_log_high'] },
                    {
                        log_level: 'info',
                        log_message: 'NowForge Speed Test B: high priority',
                    }
                )
            }
        )
        wfa.flowLogic.else(
            { $id: Now.ID['nstb_else'] },
            () => {
                wfa.action(
                    action.core.log,
                    { $id: Now.ID['nstb_log_normal'] },
                    {
                        log_level: 'info',
                        log_message: 'NowForge Speed Test B: normal priority',
                    }
                )
            }
        )
    }
)