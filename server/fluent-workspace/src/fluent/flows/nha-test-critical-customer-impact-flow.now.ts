// nowforge-spec: d2ce71303ead2b16
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'
import { StringColumn } from '@servicenow/sdk/core'

Flow(
    {
        $id: Now.ID['nct_flow'],
        name: 'NHA TEST - Critical Customer Impact Flow',
        description: 'Escalates critical incidents when no existing escalation task exists.',
        runAs: 'system',
        flowVariables: {
            escalation_sd: StringColumn({ label: 'Escalation Short Description' })
        }
    },
    wfa.trigger(
        trigger.record.createdOrUpdated,
        { $id: Now.ID['nct_trigger'] },
        {
            table: 'incident',
            condition: 'active=true^priority=1',
            run_flow_in: 'background',
            trigger_strategy: 'unique_changes'
        }
    ),
    (params) => {
        const childTask = wfa.action(
            action.core.lookUpRecords,
            { $id: Now.ID['nct_lookup_child'] },
            {
                table: 'task',
                conditions: `parent=${wfa.dataPill(params.trigger.current, 'reference')}^short_description=NHA TEST Escalation - ${wfa.dataPill(params.trigger.current.number, 'string')}`,
                max_results: 1
            }
        )

        wfa.flowLogic.if(
            {
                $id: Now.ID['nct_if_exists_or_resolved'],
                condition: `${wfa.dataPill(childTask.Count, 'integer')}!=0^OR${wfa.dataPill(params.trigger.current.incident_state, 'integer')}=6^OR${wfa.dataPill(params.trigger.current.incident_state, 'integer')}=7`
            },
            () => {
                wfa.flowLogic.endFlow({ $id: Now.ID['nct_end_already'] })
            }
        )

        wfa.flowLogic.setFlowVariables(
            { $id: Now.ID['nct_set_sd'] },
            params.flowVariables,
            {
                escalation_sd: `NHA TEST Escalation - ${wfa.dataPill(params.trigger.current.number, 'string')}`
            }
        )

        const newTask = wfa.action(
            action.core.createRecord,
            { $id: Now.ID['nct_create_task'] },
            {
                table_name: 'task',
                values: TemplateValue({
                    parent: wfa.dataPill(params.trigger.current, 'reference'),
                    short_description: wfa.dataPill(params.flowVariables.escalation_sd, 'string'),
                    description: 'Automatically generated for a critical customer-impact Incident.',
                    assignment_group: wfa.dataPill(params.trigger.current.assignment_group, 'reference'),
                    priority: '1',
                    work_notes: 'NHA TEST critical escalation initiated.'
                })
            }
        )

        wfa.flowLogic.if(
            {
                $id: Now.ID['nct_if_manager_email'],
                condition: `${wfa.dataPill(params.trigger.current.assignment_group.manager.email, 'string')}ISNOTEMPTY`
            },
            () => {
                wfa.action(
                    action.core.sendEmail,
                    { $id: Now.ID['nct_send_email'] },
                    {
                        ah_to: `${wfa.dataPill(params.trigger.current.assignment_group.manager.email, 'string')}`,
                        ah_subject: `NHA TEST Escalation - ${wfa.dataPill(params.trigger.current.number, 'string')}`,
                        ah_body: 'A critical incident has been escalated. Please review the newly created task.',
                        record: wfa.dataPill(newTask.record, 'reference'),
                        table_name: 'task'
                    }
                )
            }
        )
    }
)