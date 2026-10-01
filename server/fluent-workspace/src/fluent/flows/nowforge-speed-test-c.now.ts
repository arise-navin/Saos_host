// nowforge-spec: 4f4e165d15cc320b
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'
import { processIncidentAssignment } from './process-incident-assignment.now'

Flow(
    {
        $id: Now.ID['pcis_flow'],
        name: 'NowForge Speed Test C',
        description: 'When a new incident with short description containing "speedtest-c" is created, process its child incidents.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['pcis_trigger'] },
        {
            table: 'incident',
            condition: 'short_descriptionLIKEspeedtest-c',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        const children = wfa.action(
            action.core.lookUpRecords,
            { $id: Now.ID['pcis_lookup_children'] },
            {
                table: 'incident',
                conditions: `parent_incident=${wfa.dataPill(params.trigger.current, 'reference')}`,
            }
        )

        wfa.flowLogic.forEach(
            wfa.dataPill(children.Records, 'records'),
            { $id: Now.ID['pcis_each'] },
            (item) => {
                wfa.subflow(
                    processIncidentAssignment,
                    { $id: Now.ID['pcis_call_subflow'] },
                    {
                        incident: wfa.dataPill(item, 'reference'),
                        sendNotification: false,
                        waitForCompletion: true,
                    }
                )
            }
        )
    }
)