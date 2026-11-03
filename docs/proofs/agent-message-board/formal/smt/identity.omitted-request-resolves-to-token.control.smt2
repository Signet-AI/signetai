; benchmark generated from python API
(set-info :status unknown)
(declare-fun agent_scoped () Bool)
(declare-fun has_field () Bool)
(declare-fun has_key () Bool)
(declare-fun token () Int)
(declare-fun daemon_default () Int)
(declare-fun key_inferred () Int)
(declare-fun request_field () Int)
(assert
 agent_scoped)
(assert
 (not has_field))
(assert
 (not has_key))
(assert
 (let ((?x847 (ite has_field request_field key_inferred)))
(let (($x849 (or has_field has_key)))
(let (($x66 (= (ite $x849 ?x847 daemon_default) token)))
(not $x66)))))
(check-sat)
